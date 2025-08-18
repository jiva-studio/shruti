import requests
from bs4 import BeautifulSoup
import os
import re
import time

# Create pages folder if it doesn't exist
if not os.path.exists('pages'):
    os.makedirs('pages')

# Base URL for the transcript pages
base_url = 'https://vedabase.io/en/library/transcripts/?page='
transcript_pattern = re.compile(r'/en/library/transcripts/[^/]+/$')

# Loop through pages 1 to 309
for page_num in range(1, 310):
    try:
        # Fetch the listing page
        response = requests.get(f'{base_url}{page_num}', timeout=10)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, 'html.parser')

        # Find all links matching the transcript pattern
        links = soup.find_all('a', href=transcript_pattern)
        for link in links:
            href = link.get('href')
            # Extract ID from URL (e.g., /transcripts/<ID>/)
            transcript_id = href.strip('/').split('/')[-1]
            transcript_url = f'https://vedabase.io{href}'

            # Download the transcript page
            try:
                transcript_response = requests.get(transcript_url, timeout=10)
                transcript_response.raise_for_status()

                # Save the page as <ID>.html
                file_path = os.path.join('pages', f'{transcript_id}.html')
                with open(file_path, 'w', encoding='utf-8') as f:
                    f.write(transcript_response.text)
                print(f'Saved: {file_path}')

            except requests.RequestException as e:
                print(f'Error downloading {transcript_url}: {e}')

            # Add a small delay to avoid overwhelming the server
            time.sleep(1)

    except requests.RequestException as e:
        print(f'Error fetching page {page_num}: {e}')

    # Add delay between page requests
    time.sleep(2)

print('Scraping completed.')