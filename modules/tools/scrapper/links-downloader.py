from playwright.sync_api import sync_playwright
from playwright_stealth import stealth_sync
import random
import time
import os
import shutil

def load_urls_from_file(file_path="./urls.txt"):
    """Load URLs from a text file, one URL per line"""
    urls = []
    try:
        with open(file_path, 'r', encoding='utf-8') as file:
            for line in file:
                line = line.strip()
                if line and not line.startswith('#'):  # Skip empty lines and comments
                    urls.append(line)
        print(f"Loaded {len(urls)} URLs from {file_path}")
        return urls
    except FileNotFoundError:
        print(f"Error: File {file_path} not found")
        return []
    except Exception as e:
        print(f"Error reading file {file_path}: {e}")
        return []

def process_single_url(url, url_index, total_urls):
    """Process a single URL with download handling"""
    print(f"\n{'='*60}")
    print(f"Processing URL {url_index + 1}/{total_urls}")
    print(f"URL: {url}")
    print(f"{'='*60}")
    
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
            timezone_id='America/Los_Angeles',
            accept_downloads=True
        )
        page = context.new_page()
        stealth_sync(page)
        page.evaluate('''() => { 
            Object.defineProperty(navigator, 'webdriver', {get: () => false}); 
            window.scrollBy(0, 100); 
        }''')
        page.mouse.move(random.randint(100, 500), random.randint(100, 500))

        wait_strategies = ['domcontentloaded', 'load', 'networkidle']
        downloads = []
        
        # Set up download handler
        def handle_download(download):
            downloads.append(download)
            print(f"Download started: {download.suggested_filename}")
        
        page.on("download", handle_download)
        
        try:
            print(f"Opening URL: {url}")
            
            # Try different wait strategies if needed
            for strategy in wait_strategies:
                try:
                    page.goto(url, wait_until=strategy, timeout=30000)
                    print(f"Successfully loaded with strategy: {strategy}")
                    break
                except Exception as e:
                    print(f"Failed with strategy {strategy}: {e}")
                    if strategy == wait_strategies[-1]:
                        raise e
            
            # Add human-like delays and movements
            page.wait_for_timeout(random.randint(2000, 4000))
            page.mouse.move(random.randint(200, 800), random.randint(200, 600))
            page.wait_for_timeout(random.randint(1000, 2000))
            
            # First click coordinates
            click_x1 = 1083
            click_y1 = 587
            
            print(f"First click at position: ({click_x1}, {click_y1})")
            
            # Human-like mouse movement to first target position
            current_x, current_y = random.randint(100, 300), random.randint(100, 300)
            steps = random.randint(5, 10)
            for i in range(steps):
                intermediate_x = current_x + (click_x1 - current_x) * (i + 1) / steps
                intermediate_y = current_y + (click_y1 - current_y) * (i + 1) / steps
                page.mouse.move(intermediate_x, intermediate_y)
                page.wait_for_timeout(random.randint(50, 150))
            
            # First click
            page.mouse.click(click_x1, click_y1)
            print(f"First click performed at ({click_x1}, {click_y1})")
            
            # Wait exactly 750ms
            page.wait_for_timeout(750)
            print("Waited 750ms")
            
            # Second click coordinates
            click_x2 = 971
            click_y2 = 520
            
            print(f"Second click at position: ({click_x2}, {click_y2})")
            
            # Second click (this might trigger download)
            page.mouse.click(click_x2, click_y2)
            print(f"Second click performed at ({click_x2}, {click_y2})")
            
            # Wait a bit to see if download starts
            page.wait_for_timeout(2000)
            
            # Wait for downloads to complete
            if downloads:
                print(f"Found {len(downloads)} download(s). Waiting for completion...")
                for i, download in enumerate(downloads):
                    try:
                        print(f"Waiting for download {i+1}: {download.suggested_filename}")
                        
                        # Wait for download to complete (timeout after 5 minutes)
                        download_path = download.path()
                        if download_path:
                            print(f"Download {i+1} completed: {download_path}")
                            
                            # Create downloads directory if it doesn't exist
                            downloads_dir = "./downloads"
                            os.makedirs(downloads_dir, exist_ok=True)
                            
                            # Generate final filename with timestamp and URL index to avoid conflicts
                            timestamp = int(time.time())
                            filename = download.suggested_filename or f"download_{timestamp}"
                            final_path = os.path.join(downloads_dir, filename)
                            
                            # Move the downloaded file to downloads folder
                            shutil.move(download_path, final_path)
                            print(f"Download saved to: {final_path}")
                            return True  # Successful download
                        else:
                            print(f"Download {i+1} failed or was cancelled")
                            
                    except Exception as e:
                        print(f"Error handling download {i+1}: {e}")
            else:
                print("No downloads detected")
                # Wait a bit more in case download is delayed
                page.wait_for_timeout(5000)
                
                # Check again for downloads
                if downloads:
                    print("Late download detected, processing...")
                    for i, download in enumerate(downloads):
                        try:
                            download_path = download.path()
                            if download_path:
                                downloads_dir = "./downloads"
                                os.makedirs(downloads_dir, exist_ok=True)
                                timestamp = int(time.time())
                                filename = download.suggested_filename or f"download_{timestamp}"
                                final_path = os.path.join(downloads_dir, f"url{url_index+1:03d}_{timestamp}_{filename}")
                                shutil.move(download_path, final_path)
                                print(f"Late download saved to: {final_path}")
                                return True  # Successful download
                        except Exception as e:
                            print(f"Error handling late download: {e}")
            
            # Wait after handling downloads to capture the result
            page.wait_for_timeout(random.randint(3000, 5000))
            
        except Exception as e:
            print(f"An error occurred processing URL {url}: {e}")
            return False  # Failed processing
            
        finally:
            # Close page and browser
            page.close()
            browser.close()
    
    return False  # No download occurred

def process_all_urls():
    """Load URLs from file and process each one"""
    # Load URLs from file
    urls = load_urls_from_file("./urls.txt")
    
    if not urls:
        print("No URLs to process. Please check ./urls.txt file.")
        return
    
    # Statistics
    successful_downloads = 0
    failed_downloads = 0
    
    # Process each URL
    for i, url in enumerate(urls):
        try:
            success = process_single_url(url, i, len(urls))
            if success:
                successful_downloads += 1
                print(f"✅ Successfully processed URL {i+1}")
            else:
                failed_downloads += 1
                print(f"❌ Failed to process URL {i+1}")
                
            # Add delay between URLs to avoid being rate-limited
            if i < len(urls) - 1:  # Don't wait after the last URL
                delay = random.randint(3, 8)
                print(f"Waiting {delay} seconds before next URL...")
                time.sleep(delay)
                
        except Exception as e:
            failed_downloads += 1
            print(f"❌ Error processing URL {i+1}: {e}")
    
    # Print final statistics
    print(f"\n{'='*60}")
    print("FINAL RESULTS")
    print(f"{'='*60}")
    print(f"Total URLs processed: {len(urls)}")
    print(f"Successful downloads: {successful_downloads}")
    print(f"Failed downloads: {failed_downloads}")
    print(f"Success rate: {(successful_downloads/len(urls)*100):.1f}%")
    print(f"{'='*60}")

if __name__ == "__main__":
    # Create necessary directories if they don't exist
    os.makedirs("videos", exist_ok=True)  
    os.makedirs("downloads", exist_ok=True)
    process_all_urls()