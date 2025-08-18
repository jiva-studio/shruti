from playwright.sync_api import sync_playwright
from playwright_stealth import stealth_sync
from bs4 import BeautifulSoup
import unicodedata
import os
import time
import logging
import re
import random

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

def normalize_filename(url):
    filename = url.strip('/').split('/')[-1] + '.html'
    normalized = unicodedata.normalize('NFKD', filename).encode('ASCII', 'ignore').decode('ASCII')
    return normalized.replace('%', '')

def download_page(url, filename, max_retries=3):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--disable-blink-features=AutomationControlled'])
        context = browser.new_context(
            viewport={'width': 1920, 'height': 1080},
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
            locale='en-US',
            geolocation={'latitude': 37.7749, 'longitude': -122.4194},
            permissions=['geolocation'],
            java_script_enabled=True,
            color_scheme='light',
            timezone_id='America/Los_Angeles'
        )
        page = context.new_page()
        stealth_sync(page)
        page.evaluate('''() => { Object.defineProperty(navigator, 'webdriver', {get: () => false}); window.scrollBy(0, 100); }''')
        page.mouse.move(random.randint(100, 500), random.randint(100, 500))

        wait_strategies = ['domcontentloaded', 'load', 'networkidle']
        for attempt in range(1, max_retries + 1):
            for wait_strategy in wait_strategies:
                try:
                    logging.info(f"Attempt {attempt} with wait_until={wait_strategy} for {url}")
                    page.goto(url, wait_until=wait_strategy, timeout=60000)
                    page.wait_for_timeout(random.randint(1000, 3000))
                    page_content = page.content()
                    page_title = page.title()
                    logging.info(f"Page title: {page_title}")
                    if "Just a moment" in page_title or "Access denied" in page_title:
                        logging.warning(f"Cloudflare challenge detected at {url}")
                        raise Exception("Cloudflare challenge page detected")
                    with open(filename, 'w', encoding='utf-8') as f:
                        f.write(page_content)
                    logging.info(f"Saved: {filename}")
                    browser.close()
                    return page_content
                except Exception as e:
                    logging.error(f"Attempt {attempt} with wait_until={wait_strategy} failed for {url}: {str(e)}")
                    if attempt == max_retries and wait_strategy == wait_strategies[-1]:
                        logging.error(f"Max retries reached for {url}. Saving error page and screenshot.")
                        page.screenshot(path=f"screenshot_{filename.replace('.html', '.png')}")
                        error_content = page.content()
                        with open(f"error_{filename}", 'w', encoding='utf-8') as f:
                            f.write(error_content)
                        browser.close()
                        return None
                    time.sleep(2 ** attempt)
        browser.close()

def get_transcription_links(page_content, base_url='https://prabhupadavani.org'):
    soup = BeautifulSoup(page_content, 'html.parser')
    links = []
    for a_tag in soup.find_all('a', href=True):
        href = a_tag['href']
        if re.match(r'^/transcriptions/[^/?]+', href):
            full_url = base_url + href
            links.append(full_url)
    return list(set(links))

def main():
    base_url = 'https://prabhupadavani.org/transcriptions/?audio=Has+audio&page='
    total_pages = 310

    for page_num in range(1, total_pages + 1):
        index_url = f'{base_url}{page_num}'
        logging.info(f"Processing index page: {index_url}")
        
        index_filename = f'index_page_{page_num}.html'
        index_content = download_page(index_url, index_filename)
        
        if not index_content:
            logging.error(f"Failed to download index page {index_url}. Skipping.")
            continue
            
        transcription_links = get_transcription_links(index_content)
        logging.info(f"Found {len(transcription_links)} transcription links on page {page_num}")
        
        for link in transcription_links:
            filename = normalize_filename(link)
            if os.path.exists(filename):
                logging.info(f"Skipping {filename} (already exists)")
                continue
            page_content = download_page(link, filename)
            if not page_content:
                logging.error(f"Failed to download transcription page: {link}")
            time.sleep(2)

if __name__ == '__main__':
    main()