import os
import re
from bs4 import BeautifulSoup

def extract_mp3_links(directory):
    # Set to store unique MP3 links
    mp3_links = set()
    
    # Regular expression for MP3 files
    mp3_pattern = re.compile(r'\.mp3$', re.IGNORECASE)
    
    # Iterate through all files in the directory
    for filename in os.listdir(directory):
        if filename.endswith('.html') or filename.endswith('.htm'):
            file_path = os.path.join(directory, filename)
            
            try:
                # Read HTML file
                with open(file_path, 'r', encoding='utf-8') as file:
                    soup = BeautifulSoup(file, 'html.parser')
                    
                    # Find all anchor tags
                    for link in soup.find_all('a', href=True):
                        href = link['href']
                        # Check if the link points to an MP3 file
                        if mp3_pattern.search(href):
                            mp3_links.add(href)
                            
            except Exception as e:
                print(f"Error processing {filename}: {str(e)}")
    
    return list(mp3_links)

def main():
    # Get current directory (can be modified to specific directory)
    directory = '../pages2'
    
    # Extract MP3 links
    mp3_links = extract_mp3_links(directory)
    
    # Print results
    if mp3_links:
        print("Found unique MP3 links:")
        for link in mp3_links:
            print(link)
    else:
        print("No MP3 links found in HTML files.")

if __name__ == "__main__":
    main()