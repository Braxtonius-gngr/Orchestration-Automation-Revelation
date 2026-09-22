import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';

class JumpTaskAutomator {
	constructor(userDataDir = './user_data') {
		this.userDataDir = path.resolve(userDataDir);
		this.context = null;
		this.controllerPage = null;
		console.log(`Persistent profile path: ${this.userDataDir}`);
		console.log(`Manual browser login command: chromium --user-data-dir=${this.userDataDir}`);
	}

	async init(dashboardUrl) {
		this.context = await chromium.launchPersistentContext(this.userDataDir, {
			headless: process.env.HEADLESS !== 'false',
			args: [
				'--disable-blink-features=AutomationControlled',
				'--no-sandbox',
				'--disable-setuid-sandbox',
				'--disable-dev-shm-usage',
			],
			ignoreDefaultArgs: ['--enable-automation'],
		});

		const pages = this.context.pages();
		this.controllerPage = pages.length > 0 ? pages[0] : await this.context.newPage();
		await this.controllerPage.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
	}

	async ensureAuthenticated() {
		const pageUrl = this.controllerPage.url();
		const authenticated = /\/my-account|\/offers|\/dashboard/i.test(pageUrl)
			|| (await this.controllerPage.getByRole('button', { name: /Start Task|Continue/i }).first().isVisible({ timeout: 1500 }).catch(() => false));
		if (authenticated) return;

		const loginCandidate = this.controllerPage.locator(
			'button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in"), a:has-text("Log in"), a:has-text("Login"), a:has-text("Sign in"), button:has-text("Continue with Google"), button:has-text("Continue with wallet")'
		).first();
		if (await loginCandidate.isVisible({ timeout: 2500 }).catch(() => false)) {
			await loginCandidate.click();
			await this.controllerPage.waitForTimeout(2000);
		}

		const googleAuthPopup = this.context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
		const googleButton = this.controllerPage.locator(
			'button:has-text("Continue with Google"), button:has-text("Log in with Google"), a:has-text("Continue with Google")'
		).first();
		if (await googleButton.isVisible({ timeout: 2500 }).catch(() => false)) {
			await googleButton.click();
			const authPage = await googleAuthPopup;
			if (authPage) {
				await authPage.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
			}
		}

		await this.controllerPage.waitForTimeout(3000);
		const stillLoggedOut = await this.controllerPage.locator(
			'button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in"), a:has-text("Log in"), a:has-text("Login"), a:has-text("Sign in")'
		).first().isVisible({ timeout: 1500 }).catch(() => false);
		if (stillLoggedOut) {
			throw new Error('JumpTask login flow was detected but no authenticated session was established.');
		}
	}

	async parseModalInstructions() {
		await this.controllerPage.waitForFunction(
			() => document.body.innerText.includes('Search this keyword:'),
			{ timeout: 15000 },
		);

		const modalText = await this.controllerPage.locator('body').innerText();
		const keywordMatch = modalText.match(/Search this keyword:\s*\n+([^\n\r]+)/i);
		const searchKeyword = keywordMatch ? keywordMatch[1].trim() : 'earn money online';
		const headingMatch = modalText.match(/section called\s+([^,]+),/i);
		const sectionHeading = headingMatch ? headingMatch[1].trim() : 'Not money for nothing';
		const exampleLink = this.controllerPage.locator('a').filter({ hasText: /see example/i }).first();
		if (!(await exampleLink.count())) {
			await this.controllerPage.screenshot({ path: 'debug-jumptask-page.png', fullPage: true });
			await fs.writeFile('debug-jumptask-page.html', await this.controllerPage.content());
			const loginVisible = await this.controllerPage
				.getByRole('button', { name: /log in with google|connect with wallet/i })
				.first()
				.isVisible()
				.catch(() => false);
			const reason = loginVisible ? 'the JumpTask session is not authenticated' : 'the offer layout has changed';
			throw new Error(`Could not find the task example link because ${reason}. Debug files were saved.`);
		}
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
		const consentButton = searchPage.locator('button:has-text("Accept all"), button:has-text("Reject all"), button:has-text("I agree"), #L2AGLb').first();
		if (await consentButton.isVisible({ timeout: 2500 }).catch(() => false)) {
			await consentButton.click();
			await searchPage.waitForLoadState('domcontentloaded');
		}
		const searchInput = searchPage.locator('textarea[name="q"], input[name="q"]').first();
		await searchInput.waitFor({ state: 'visible' });
		await searchInput.fill(searchKeyword);
		await searchInput.press('Enter');
		const maxPages = 5;
		let targetLink = null;
		for (let current = 1; current <= maxPages; current++) {
			await searchPage.waitForLoadState('domcontentloaded');
			const matchingLinks = searchPage.locator(`a[href*="${targetDomain}"]`);
			if (await matchingLinks.count() > 0) { targetLink = matchingLinks.first(); break; }
			const nextButton = searchPage.locator('#pnnext, a[aria-label="Next page"], a[aria-label="Next"]').first();
			if (await nextButton.isVisible({ timeout: 2000 }).catch(() => false)) await nextButton.click();
			else break;
		}
		if (!targetLink) { await searchPage.close(); throw new Error(`Target domain "${targetDomain}" not found in top ${maxPages} Google pages.`); }
		const targetPagePromise = this.context.waitForEvent('page', { timeout: 3000 }).catch(() => null);
		await targetLink.click();
		const targetPage = (await targetPagePromise) || searchPage;
		await targetPage.waitForLoadState('domcontentloaded');
		return { searchPage, targetPage };
	}

	async extractTargetWords(targetPage, sectionHeading) {
		const headingLocator = targetPage.locator('h1, h2, h3, h4, h5, h6', { hasText: new RegExp(sectionHeading, 'i') }).first();
		await headingLocator.waitFor({ state: 'attached', timeout: 10000 });
		await headingLocator.scrollIntoViewIfNeeded();
		const paragraph = headingLocator.locator('xpath=following::p[normalize-space()][1]');
		await paragraph.waitFor({ state: 'visible', timeout: 5000 });
		const rawText = await paragraph.innerText();
		const sentenceMatch = rawText.match(/^.*?[.!?](?:\s|$)/);
		const firstSentence = sentenceMatch ? sentenceMatch[0].trim() : rawText.trim();
		const cleanWords = firstSentence.replace(/[.,/#!$%^&*;:{}=\-_`~()?"']/g, '').split(/\s+/).filter(Boolean);
		if (cleanWords.length < 2) throw new Error(`Sentence too short to extract 2 words: "${firstSentence}"`);
		return cleanWords.slice(-2).join(' ');
	}

	async submitAndVerify(extractedAnswer) {
		await this.controllerPage.bringToFront();
		const balanceLocator = this.controllerPage.locator('text=/^[0-9]+\.[0-9]{2}$/').first();
		const initialBalance = await balanceLocator.isVisible() ? await balanceLocator.innerText() : null;
		const startButton = this.controllerPage.getByRole('button', { name: /Start Task/i });
		if (await startButton.isVisible({ timeout: 2000 }).catch(() => false)) { await startButton.click(); await this.controllerPage.waitForTimeout(1000); }
		const inputField = this.controllerPage.getByPlaceholder(/Enter text here/i).first();
		await inputField.waitFor({ state: 'visible', timeout: 5000 });
		await inputField.click();
		await inputField.pressSequentially(extractedAnswer, { delay: 65 });
		const submitButton = this.controllerPage.getByRole('button', { name: /Submit/i });
		await submitButton.waitFor({ state: 'visible', timeout: 5000 });
		await submitButton.click();
		try {
			await Promise.race([
				this.controllerPage.locator('div[role="dialog"]').waitFor({ state: 'hidden', timeout: 10000 }),
				balanceLocator.filter({ hasNotText: initialBalance }).waitFor({ state: 'visible', timeout: 10000 }),
			]);
			console.log('Reward verified: Balance updated or modal successfully dismissed.');
		} catch { console.warn('Submission fired, but automatic balance verification timed out.'); }
	}

	async run(url) {
		try {
			await this.init(url);
			console.log('1. Ensuring JumpTask session is authenticated...');
			await this.ensureAuthenticated();
			console.log('1. Parsing task modal instructions...');
			const { searchKeyword, sectionHeading, targetDomain } = await this.parseModalInstructions();
			console.log(`Parsed: Keyword="${searchKeyword}", Heading="${sectionHeading}", Domain="${targetDomain}"`);
			console.log('2. Searching Google and navigating to target...');
			const { searchPage, targetPage } = await this.findAndOpenTarget(searchKeyword, targetDomain);
			console.log('3. Extracting target words...');
			const answer = await this.extractTargetWords(targetPage, sectionHeading);
			console.log(`Extracted text: "${answer}"`);
			await targetPage.close();
			await searchPage.close();
			console.log('4. Entering payload and submitting...');
			await this.submitAndVerify(answer);
		} catch (err) { console.error(`Task Execution Error: ${err.message}`); }
			finally { await this.context?.close(); }
	}
}

const automator = new JumpTaskAutomator();
automator.run('https://app.jumptask.io/my-account/offers/jumpoffers/11106?origin=my_account&type=suggested_offer');
