import { chromium } from 'playwright';
import path from 'node:path';

class JumpTaskAutomator {
  constructor(userDataDir = './user_data') {
    this.userDataDir = path.resolve(userDataDir);
    this.context = null;
    this.controllerPage = null;
  }

  async init(dashboardUrl) {
    this.context = await chromium.launchPersistentContext(this.userDataDir, {
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });
    const pages = this.context.pages();
    this.controllerPage = pages[0] || await this.context.newPage();
    await this.controllerPage.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
  }

  async parseModalInstructions() {
    const modal = this.controllerPage.locator('div[role="dialog"], .modal, body').filter({
      hasText: 'Instructions',
    }).first();
    await modal.waitFor({ state: 'visible', timeout: 8000 });
    const modalText = await modal.innerText();
    const keywordMatch = modalText.match(/Search this keyword:\s*\n+([^\n\r]+)/i);
    const headingMatch = modalText.match(/section called\s+([^,]+),/i);
    const searchKeyword = keywordMatch?.[1].trim() || 'earn money online';
    const sectionHeading = headingMatch?.[1].trim() || 'Not money for nothing';
    const exampleLink = modal.locator('a', { hasText: /see example/i }).first();
    await exampleLink.waitFor({ state: 'attached', timeout: 5000 });
    const exampleHref = await exampleLink.getAttribute('href');

    let targetDomain = '';
    try {
      const parsedUrl = new URL(exampleHref);
      targetDomain = parsedUrl.searchParams.get('url') || parsedUrl.hostname.replace(/^www\./, '');
    } catch {
      targetDomain = exampleHref.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
    }
    return { searchKeyword, sectionHeading, targetDomain };
  }

  async findAndOpenTarget(searchKeyword, targetDomain) {
    const searchPage = await this.context.newPage();
    await searchPage.goto('https://www.google.com', { waitUntil: 'domcontentloaded' });
    const consentButton = searchPage.locator(
      'button:has-text("Accept all"), button:has-text("Reject all"), button:has-text("I agree"), #L2AGLb',
    ).first();
    if (await consentButton.isVisible({ timeout: 2500 }).catch(() => false)) {
      await consentButton.click();
      await searchPage.waitForLoadState('domcontentloaded');
    }

    const searchInput = searchPage.locator('textarea[name="q"], input[name="q"]').first();
    await searchInput.waitFor({ state: 'visible' });
    await searchInput.fill(searchKeyword);
    await searchInput.press('Enter');

    let targetLink = null;
    for (let current = 1; current <= 5; current++) {
      await searchPage.waitForLoadState('domcontentloaded');
      const matchingLinks = searchPage.locator(`a[href*="${targetDomain}"]`);
      if (await matchingLinks.count()) {
        targetLink = matchingLinks.first();
        break;
      }
      const nextButton = searchPage.locator('#pnnext, a[aria-label="Next page"], a[aria-label="Next"]').first();
      if (await nextButton.isVisible({ timeout: 2000 }).catch(() => false)) await nextButton.click();
      else break;
    }
    if (!targetLink) {
      await searchPage.close();
      throw new Error(`Target domain "${targetDomain}" not found in top 5 Google pages.`);
    }

    const targetPagePromise = this.context.waitForEvent('page', { timeout: 3000 }).catch(() => null);
    await targetLink.click();
    const targetPage = (await targetPagePromise) || searchPage;
    await targetPage.waitForLoadState('domcontentloaded');
    return { searchPage, targetPage };
  }

  async extractTargetWords(targetPage, sectionHeading) {
    const headingLocator = targetPage.locator('h1, h2, h3, h4, h5, h6', {
      hasText: new RegExp(sectionHeading, 'i'),
    }).first();
    await headingLocator.waitFor({ state: 'attached', timeout: 10000 });
    await headingLocator.scrollIntoViewIfNeeded();
    const paragraph = headingLocator.locator('xpath=following::p[normalize-space()][1]');
    await paragraph.waitFor({ state: 'visible', timeout: 5000 });
    const rawText = await paragraph.innerText();
    const sentenceMatch = rawText.match(/^.*?[.!?](?:\s|$)/);
    const firstSentence = (sentenceMatch ? sentenceMatch[0] : rawText).trim();
    const cleanWords = firstSentence.replace(/[.,/#!$%^&*;:{}=\-_`~()?"']/g, '').split(/\s+/).filter(Boolean);
    if (cleanWords.length < 2) throw new Error(`Sentence too short to extract 2 words: "${firstSentence}"`);
    return cleanWords.slice(-2).join(' ');
  }

  async submitAndVerify(extractedAnswer) {
    await this.controllerPage.bringToFront();
    const balanceLocator = this.controllerPage.locator('text=/^[0-9]+\.[0-9]{2}$/').first();
    const initialBalance = await balanceLocator.isVisible().catch(() => false)
      ? await balanceLocator.innerText() : null;
    const startButton = this.controllerPage.getByRole('button', { name: /Start Task/i });
    if (await startButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await startButton.click();
      await this.controllerPage.waitForTimeout(1000);
    }
    const inputField = this.controllerPage.getByPlaceholder(/Enter text here/i).first();
    await inputField.waitFor({ state: 'visible', timeout: 5000 });
    await inputField.pressSequentially(extractedAnswer, { delay: 65 });
    await this.controllerPage.getByRole('button', { name: /Submit/i }).click();

    try {
      const modalDismissed = this.controllerPage.locator('div[role="dialog"]').waitFor({ state: 'hidden', timeout: 10000 });
      const balanceChanged = initialBalance === null ? Promise.resolve() : this.controllerPage
        .locator('text=/^[0-9]+\.[0-9]{2}$/').filter({ hasNotText: initialBalance }).first()
        .waitFor({ state: 'visible', timeout: 10000 });
      await Promise.race([modalDismissed, balanceChanged]);
      console.log('Reward verified: balance updated or modal dismissed.');
    } catch {
      console.warn('Submission fired, but automatic balance verification timed out.');
    }
  }

  async run(url) {
    try {
      await this.init(url);
      console.log('1. Parsing task modal instructions...');
      const { searchKeyword, sectionHeading, targetDomain } = await this.parseModalInstructions();
      console.log(`Parsed: Keyword="${searchKeyword}", Heading="${sectionHeading}", Domain="${targetDomain}"`);
      console.log('2. Searching Google and navigating to target...');
      const { searchPage, targetPage } = await this.findAndOpenTarget(searchKeyword, targetDomain);
      console.log('3. Extracting target words...');
      const answer = await this.extractTargetWords(targetPage, sectionHeading);
      console.log(`Extracted text: "${answer}"`);
      if (targetPage !== searchPage) await targetPage.close();
      await searchPage.close();
      console.log('4. Entering payload and submitting...');
      await this.submitAndVerify(answer);
    } catch (error) {
      console.error(`Task execution error: ${error.message}`);
    } finally {
      await this.context?.close();
    }
  }
}

const dashboardUrl = process.argv[2]
  || 'https://app.jumptask.io/my-account/offers/jumpoffers/11106?origin=my_account&type=suggested_offer';
await new JumpTaskAutomator().run(dashboardUrl);
