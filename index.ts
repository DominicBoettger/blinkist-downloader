#!/usr/bin/env tsx

import { cfg } from './config.js';
import { context, page } from './playwright.js';
import type { BrowserContext, Page } from 'playwright-chromium';
import fs from 'node:fs';
import chalk from 'chalk';

type library = 'saved' | 'finished';
type book = {
  id: string,
  title: string,
  author: string,
  description: string,
  duration: number,
  rating: number,
  url: string,
  img: string,
};

fs.mkdirSync('books', { recursive: true });
// json database to save lists from https://www.blinkist.com/en/app/library
import { JSONFilePreset } from 'lowdb/node';
const defaultData : { guides: book[], saved: book[], finished: book[] } = { guides: [], saved: [], finished: [] };
const db = await JSONFilePreset('books/db.json', defaultData);

const cookieConsent = async (context: BrowserContext) => {
  return context.addCookies([
    { name: 'CookieConsent', value: JSON.stringify({stamp:'V2Zm11G30yff5ZZ8WLu8h+BPe03juzWMZGOyPF4bExMdyYwlFj+3Hw==',necessary:true,preferences:true,statistics:true,marketing:true,method:'explicit',ver:1,utc:1716329838000,region:'de'}), domain: 'www.blinkist.com', path: '/' }, // Accept cookies since consent banner overlays and blocks screen
  ]);
  // page.locator('button:has-text("Allow all cookies")').click().catch(() => {}); // solved by setting cookie above
};

const login = async (page: Page) => {
  await page.goto('https://www.blinkist.com/en/app/library/saved');
  // redirects if not logged in to https://www.blinkist.com/en/nc/login?last_page_before_login=/en/app/library/saved
  return Promise.any([page.waitForURL(/.*login.*/).then(() => {
    console.error('Not logged in! Will wait for 120s for you to log in...');
    return page.waitForTimeout(120*1000);
  }), page.locator('h3:has-text("Saved")').waitFor()]);
}

const updateLibrary = async (page: Page, list: library = 'saved') => {
  const dbList = db.data[list]; // sorted by date added ascending
  // sorted by date added descending
  const url = 'https://www.blinkist.com/en/app/library/' + list;
  await page.goto(url);
  const newBooks = [];

  console.log('Updating library:', url);
  console.log(list, 'books in db.json:', dbList.length);

  const listItems = page.locator(`div:has-text("${list}") p`);
  const nextBtn = page.locator('button:has-text("Next"):not([disabled])');
  pages: do { // go through pages
    const items = await listItems.innerText();
    console.log('Current page:', items);
    const books = await page.locator('a[data-test-id="book-card"]').all();
    for (const book of books) {
      const slug = await book.getAttribute('href');
      if (!slug) throw new Error('Book has no href attribute!');
      const id = slug.split('/').pop() ?? slug;
      const url = 'https://www.blinkist.com' + slug;
      const title = await book.getAttribute('aria-label');
      if (!title) throw new Error('Book has no title / aria-label attribute!');
      const img = await book.locator('img').getAttribute('src');
      if (!img) throw new Error('Book has no img src attribute!');
      const author = await book.locator('[data-test-id="subtitle"]').innerText();
      const description = await book.locator('[data-test-id="description"]').innerText();
      // const details = await book.locator('div:below([data-test-id="description"])').innerText();
      let meta = (await book.locator('div.text-mid-grey.text-caption.mt-2').last().innerText()).split('\n');
      const duration = parseFloat(meta[0].replace(' min', ''));
      const rating = parseFloat(meta[1]);
      const item: book = { id, title, author, description, duration, rating, url, img };
      if (dbList.find(i => i.id === id)) {
        if (!cfg.checkall) {
          console.log('Stopping at book already found in db.json:', item);
          break pages;
        } else {
          console.log('Book already in db.json:', item.id);
        }
      } else if (list === 'finished' && db.data.saved.find(i => i.id === id)) {
        // after downloading a book (even with reset to start), it will also appear in finished list
        // since we don't want to download it in finished as well, we skip it here
        // TODO to mark a book as finished, move it from saved to finished in books/db.json and books/
        console.log('Skipping book already in saved list:', item.id);
      } else {
        console.log('New book:', item);
        newBooks.push(item);
      }
    }
    // await page.pause();
    if (await nextBtn.count()) { // while next button is not disabled; can't check this in do-while condition since it would already be false after click()
      await nextBtn.click(); // click next page button
      // wait until items on page have been updated
      while (items === await listItems.innerText()) {
        // console.log('Waiting for 500ms...');
        await page.waitForTimeout(500);
      }
    } else break;
  } while (true);
  // add new books to db.json in reverse order
  dbList.push(...newBooks.toReversed());
  await db.write(); // write out json db
  console.log('New books:', newBooks.length);
  console.log();
};

const downloadFile = (url: string, path: string) => fetch(url).then(res => res.arrayBuffer()).then(bytes => fs.writeFileSync(path, Buffer.from(bytes)));

const downloadBooks = async (page: Page, list: library = 'saved') => {
  const dbList = db.data[list]; // sorted by date added ascending
  console.log('Check/download new books:', list);
  console.log(list, 'books in db.json:', dbList.length);

  let i = 0;
  for (const book of dbList) {
    i++;
    const bookDir = `books/${list}/${book.id}/`;
    const bookJson = bookDir + 'book.json';
    const existsDir = fs.existsSync(bookDir);
    const existsJson = existsDir && fs.existsSync(bookJson);
    const existsAudio = existsDir && fs.existsSync(bookDir + 'Summary.m4a');
    console.log(`Book ${i}:`, book.id,
                existsDir ?
                  (existsJson ?
                    (existsAudio ? chalk.green('exists') : chalk.yellow('audio missing'))
                  : chalk.red('missing'))
                : chalk.yellow('download'));
    if (existsDir) continue;
    console.log(`Downloading book (${dbList.length - i} left):`, book.url);
    const gql = page.waitForResponse(r => r.request().method() == 'POST' && r.url() == 'https://gql-gateway.blinkist.com/graphql');
    await page.goto('https://www.blinkist.com/en/app/books/' + book.id);
    
    // Try to get content state from GraphQL response, but don't fail if it's not available
    let contentState = undefined;
    try {
      const response = await gql;
      const json = await response.json();
      contentState = json?.data?.user?.contentStateByContentTypeAndId;
    } catch (error) {
      console.log('Could not get contentState from GraphQL:', (error as Error).message);
    }
    
    // Try multiple selectors to find the details section (page structure may have changed)
    const detailsBoxSelectors = [
      'div:has(h4)',  // original selector
      '[data-test-id="book-details"]',  // common test id pattern
      'section:has(h4)',  // might be a section now
      'div[class*="details"]',  // any div with "details" in class name
    ];
    
    let detailsBox = null;
    for (const selector of detailsBoxSelectors) {
      detailsBox = page.locator(selector).last();
      try {
        await detailsBox.waitFor({ timeout: 3000 });
        console.log(`Found details box with selector: ${selector}`);
        break;
      } catch {
        detailsBox = null;
      }
    }
    
    // Try to extract details from the page
    let categories: string[] = [];
    let descriptionLong = book.description || '';
    let authorDetails = book.author || '';
    let ratings = undefined;
    let durationDetail = undefined;
    
    if (detailsBox) {
      try {
        const detailDivs = await detailsBox.locator('div').all();
        console.log(`Found ${detailDivs.length} detail divs`);
        
        // Try to extract information with fallbacks
        if (detailDivs.length >= 2) {
          categories = await detailDivs[1].locator('a').all().then(a => Promise.all(a.map(a => a.innerText()))).catch(() => []);
        }
        if (detailDivs.length >= 3) {
          descriptionLong = await detailDivs[2].innerHTML().catch(() => book.description || '');
        }
        if (detailDivs.length >= 4) {
          authorDetails = await detailDivs[3].innerHTML().catch(() => book.author || '');
        }
      } catch (error) {
        console.log('Error extracting details from detailsBox:', (error as Error).message);
      }
    } else {
      console.log(chalk.yellow('Could not find details box, using basic metadata from library'));
    }
    
    // Try to get ratings and duration from anywhere on the page
    ratings = await page.locator('span:has-text(" ratings)")').innerText({ timeout: 200 }).catch(() => undefined);
    durationDetail = await page.locator('span:has-text(" mins")').innerText({ timeout: 200 }).catch(() => undefined);
    
    const details = { ...book, ratings, durationDetail, categories, descriptionLong, authorDetails, contentState };
    console.log('Details:', details);

    const chapters = [];
    let orgChapter = undefined;
    
    // Set up network monitoring to capture audio URLs BEFORE they become blobs
    // This must be done BEFORE navigation to the reader page
    let currentAudioUrls: string[] = [];
    
    const audioHandler = async (response: any) => {
      try {
        const url = response.url();
        // Skip blob URLs entirely
        if (url.startsWith('blob:')) {
          return;
        }
        const contentType = response.headers()['content-type'] || '';
        // Capture any audio files or media URLs (but not blobs)
        if (url.includes('.m4a') || url.includes('.mp3') || url.includes('.aac') || 
            url.includes('/audio/') || url.includes('/media/') ||
            contentType.includes('audio/')) {
          console.log(chalk.cyan(`  ✓ Captured audio URL: ${url}`));
          currentAudioUrls.push(url);
        }
      } catch (e) {
        // Ignore errors from handler
      }
    };
    
    page.on('response', audioHandler);
    
    // Try to download chapters from reader
    try {
      const resp = await page.goto('https://www.blinkist.com/en/nc/reader/' + book.id);
      console.log('Reader response status:', resp?.status());
      
      if (resp && resp.status() === 404) {
        console.error(chalk.yellow('Reader not found (404):'), book.id);
      } else {
        // Try multiple selectors for reader content (page structure may have changed)
        const readerContentSelectors = [
          '.reader-content__text',  // original selector
          '[class*="reader-content"]',  // any class with reader-content
          '[class*="ReaderContent"]',  // camelCase version
          'article',  // might be in an article tag
          '[data-test-id*="reader"]',  // any test id with reader
        ];
        
        let readerContentVisible = false;
        let workingSelector = '';
        
        for (const selector of readerContentSelectors) {
          const visible = await page.locator(selector).first().waitFor({ timeout: 3000 }).then(() => true).catch(() => false);
          if (visible) {
            readerContentVisible = true;
            workingSelector = selector;
            console.log(`Found reader content with selector: ${selector}`);
            break;
          }
        }
        
        if (!readerContentVisible) {
          console.error(chalk.yellow('Reader content did not load with any known selector:'), book.id);
          console.log('Current URL:', page.url());
          // Try to log what elements are actually on the page
          const bodyClasses = await page.locator('body').getAttribute('class').catch(() => 'N/A');
          console.log('Body classes:', bodyClasses);
          const mainElements = await page.locator('main, article, [role="main"]').count();
          console.log('Main/article elements found:', mainElements);
          // Check if we were redirected
          if (!page.url().includes('/reader/')) {
            console.log('Page was redirected away from reader');
          }
        } else {
          // chapter number (Introduction, Key idea 1...), but last chapter (summary) has no name, so we time out and return Summary
          const chapterNumber = () => page.locator('[data-test-id="currentChapterNumber"]').innerText({ timeout: 200 }).catch(() => 'Summary');
          orgChapter = await chapterNumber();
          console.log('Original chapter:', orgChapter);
          
          // Try to navigate to the first chapter
          const reset = async () => {
            const chapter = await chapterNumber();
            if (chapter === 'Introduction' || chapter === 'Einleitung') {
              console.log('Already at Introduction');
              return;
            }
            
            console.log(`Currently at: ${chapter}, trying to navigate to first chapter`);
            
            // Look for chapter links INSIDE the chapters list
            const chapterListContainer = page.locator('[data-test-id="chapters-list"]');
            const hasChapterList = await chapterListContainer.count() > 0;
            
            if (hasChapterList) {
              console.log('Found chapters list container, analyzing chapter structure');
              
              // Get the HTML structure to understand how to navigate
              const listHtml = await chapterListContainer.innerHTML().catch(() => '');
              console.log('Chapters list HTML preview:', listHtml.slice(0, 500));
              
              // Try to use keyboard navigation instead of clicking
              console.log('Attempting keyboard navigation to first chapter');
              try {
                // Focus on the chapters list
                await chapterListContainer.focus({ timeout: 1000 }).catch(() => {});
                // Press ArrowDown to go to first chapter
                await page.keyboard.press('ArrowDown');
                await page.waitForTimeout(300);
                // Press Enter to select
                await page.keyboard.press('Enter');
                await page.waitForTimeout(800);
                
                const newChapter = await chapterNumber();
                if (newChapter !== chapter) {
                  console.log(chalk.green(`✓ Navigated via keyboard from ${chapter} to ${newChapter}`));
                } else {
                  console.log(chalk.yellow('Keyboard navigation did not change chapter'));
                }
              } catch (e) {
                console.log(`Keyboard navigation failed: ${(e as Error).message.split('\n')[0]}`);
              }
            } else {
              console.log('No chapters list container found');
            }
            
            const finalChapter = await chapterNumber();
            console.log('Final position:', finalChapter);
          };
          
          await reset();
          
          // Now iterate through all chapters
          do {
            const name = await chapterNumber();
            const title = await page.locator('h2').first().innerText().catch(() => 'Untitled');
            console.log(name, title);
            
            // Use the working selector for reader content
            const text = await page.locator(workingSelector).first().innerHTML();
            
            // Check if we already have audio from page load
            let audio = null;
            if (currentAudioUrls.length > 0) {
              // Use the last captured URL (most recent)
              audio = currentAudioUrls[currentAudioUrls.length - 1];
              console.log(chalk.green(`✓ Using pre-loaded audio URL: ${audio.slice(0, 80)}...`));
            } else {
              // Try to trigger audio load by clicking play button
              console.log(chalk.dim('  Trying to trigger audio load...'));
              const playButtonSelectors = [
                'button[aria-label*="Play"]',
                'button[aria-label*="Abspielen"]',
                '[data-test-id*="play"]',
                'button:has([data-icon="play"])',
              ];
              
              for (const selector of playButtonSelectors) {
                const btn = page.locator(selector).first();
                if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
                  console.log(chalk.dim(`  Clicking play button: ${selector}`));
                  try {
                    await btn.click({ timeout: 1000 });
                    // Wait a bit for audio to start loading
                    await page.waitForTimeout(1500);
                    break;
                  } catch (e) {
                    console.log(chalk.dim(`  Could not click: ${(e as Error).message.split('\n')[0]}`));
                  }
                }
              }
              
              // Check again if we captured audio after clicking play
              if (currentAudioUrls.length > 0) {
                audio = currentAudioUrls[currentAudioUrls.length - 1];
                console.log(chalk.green(`✓ Captured audio after play: ${audio.slice(0, 80)}...`));
              } else {
                console.log(chalk.yellow('  No audio captured from network for this chapter'));
              }
            }
            
            const chapter = { name, title, text, audio };
            chapters.push(chapter);
            
            // Clear audio URLs for next chapter
            currentAudioUrls = [];
            
            const nextBtn = page.locator('[data-test-id="nextChapter"]');
            if (await nextBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
              await nextBtn.click();
              // Wait for chapter to change and for new audio to potentially load
              await page.waitForTimeout(800);
              const nextTitle = await page.locator('h2').first().innerText().catch(() => '');
              // Additional wait if title hasn't changed yet
              if (title === nextTitle) {
                await page.waitForTimeout(500);
              }
            } else {
              console.log('No more next button, reached end');
              break;
            }
          } while (true);
          
          // Try to reset to original chapter
          await reset();
        }
      }
    } catch (error) {
      console.error(chalk.yellow('Error accessing reader for book:'), book.id);
      console.error('Error:', (error as Error).message);
    }

    // write data at the end
    fs.mkdirSync(bookDir, { recursive: true });
    fs.writeFileSync(bookJson, JSON.stringify({ ...details, downloadDate: new Date(), orgChapter, chapters }, null, 2));
    await downloadFile(book.img, bookDir + 'cover.png');
    
    console.log(`Downloaded book with ${chapters.length} chapters`);
    if (chapters.length === 0) {
      console.log(chalk.yellow('Warning: No chapters were downloaded. The book content may not be available.'));
    }
    
    if (cfg.audio) {
      const chaptersWithAudio = chapters.filter(c => c.audio);
      console.log(`Downloading audio files: ${chaptersWithAudio.length} of ${chapters.length} chapters have audio`);
      for (const { name, audio } of chaptersWithAudio) {
        if (audio) {
          console.log(`  Downloading audio for: ${name}`);
          await downloadFile(audio, bookDir + name + '.m4a');
        }
      }
      if (chaptersWithAudio.length === 0 && chapters.length > 0) {
        console.log(chalk.yellow('Warning: No audio URLs found in chapters'));
      }
    }
    console.log();
    // process.exit(0);
  }
  console.log();
};

try {
  await cookieConsent(context);
  await login(page);
  
  page.locator('h2:has-text("Verify you are human by completing the action below.")').waitFor().then(() => {;
    console.error('Verify you are human by completing the action below.');
    if (cfg.headless) {
      console.error('Can not solve captcha in headless mode. Exiting...');
      process.exit(1);
    } else {
      return page.waitForTimeout(30*1000); // TODO wait until captcha is solved
    }
  }).catch(() => {});

  if (cfg.update) {
    await updateLibrary(page, 'saved');
    await updateLibrary(page, 'finished');
  }
  if (cfg.download) {
    await downloadBooks(page, 'saved');
    await downloadBooks(page, 'finished');
  }
} catch (error) {
  console.error(error); // .toString()?
  process.exitCode ||= 1;
} finally { // not reached on ctrl-c
  await db.write(); // write out json db
  await context.close();
}
