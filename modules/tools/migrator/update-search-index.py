#!/usr/bin/env python3

import requests
from sqids import Sqids
from typing import List, Dict, Any, Optional

class CouchDBProcessor:
    def __init__(self, host: str):
        self.host = host.rstrip('/')
        self.sqids = Sqids(min_length=9, alphabet='abcdefghijklmnopqrstuvwxyz')
        
    def get_all_documents(self, collection: str) -> List[Dict[str, Any]]:
        """Fetch all documents from a CouchDB collection."""
        url = f"{self.host}/{collection}/_all_docs"
        params = {'include_docs': 'true'}
        
        try:
            response = requests.get(url, params=params, verify=False)
            response.raise_for_status()
            data = response.json()
            
            # Extract documents from the response
            documents = []
            for row in data.get('rows', []):
                if 'doc' in row and not row['doc']['_id'].startswith('_design'):
                    documents.append(row['doc'])
            
            return documents
        except requests.exceptions.RequestException as e:
            print(f"Error fetching documents from {collection}: {e}")
            return []
    
    def get_document(self, collection: str, doc_id: str) -> Optional[Dict[str, Any]]:
        """Get a specific document by ID."""
        url = f"{self.host}/{collection}/{doc_id}"
        
        try:
            response = requests.get(url, verify=False)
            if response.status_code == 200:
                return response.json()
            elif response.status_code == 404:
                return None
            else:
                response.raise_for_status()
        except requests.exceptions.RequestException as e:
            print(f"Error fetching document {doc_id} from {collection}: {e}")
            return None
    
    def save_document(self, collection: str, document: Dict[str, Any]) -> bool:
        """Save a document to CouchDB."""
        doc_id = document['_id']
        url = f"{self.host}/{collection}/{doc_id}"
        
        try:
            # print(">>> ", collection, document)
            response = requests.put(url, 
                                  json=document,
                                  headers={'Content-Type': 'application/json'}, verify=False)
            response.raise_for_status()
            return True
        except requests.exceptions.RequestException as e:
            print(f"Error saving document {doc_id} to {collection}: {e}")
            return False
    
    def create_reference_strings(self, references: List[List[Any]]) -> List[str]:
        """Create reference strings from references array."""
        reference_strings = []
        
        if not references or len(references) == 0:
            return reference_strings
            
        for ref in references:
            if len(ref) < 2:  # Need at least 2 elements (skip first, use rest)
                continue
                
            # Skip first element, join the rest with "."
            try:
                # Convert all elements except first to strings and join with "."
                ref_parts = [str(part) for part in ref[1:]]
                ref_string = ".".join(ref_parts)
                reference_strings.append(ref_string)
            except Exception as e:
                print(f"Error processing reference {ref}: {e}")
                continue
        
        return reference_strings
    
    def process_tracks(self):
        """Main processing function."""
        print("Fetching all tracks...")
        tracks = self.get_all_documents('tracks')
        print(f"Found {len(tracks)} tracks")
        
        for track in tracks:
            track_id = track.get('_id')
            references = track.get('references', [])
            
            if not references:
                print(f"Track {track_id} has no references, skipping...")
                continue
            
            # Create reference strings for all references
            ref_strings = self.create_reference_strings(references)
            if not ref_strings:
                print(f"Could not create reference strings for track {track_id}")
                continue
            
            print(f"Processing track {track_id} with {len(ref_strings)} references: {ref_strings}")
            
            # Convert track ID to integer using sqids
            try:
                track_int = self.sqids.decode(track_id)[0]  # Get first decoded value
            except (IndexError, Exception) as e:
                print(f"Error decoding track ID {track_id}: {e}")
                continue
            
            # Process each reference string
            for ref_string in ref_strings:
                # Get or create index document
                index_doc = self.get_document('index', ref_string)
                
                if index_doc is None:
                    # Create new index document
                    index_doc = {
                        '_id': ref_string,
                        'tracks': []
                    }
                    print(f"Creating new index document: {ref_string}")
                else:
                    print(f"Found existing index document: {ref_string}")
                
                # Add track ID to tracks array if not already present
                if track_int not in index_doc['tracks']:
                    index_doc['tracks'].append(track_int)
                    print(f"Added track {track_int} to index {ref_string}")
                else:
                    print(f"Track {track_int} already in index {ref_string}")
                    continue
                
                # Save the index document
                if self.save_document('index', index_doc):
                    print(f"Successfully saved index document {ref_string}")
                else:
                    print(f"Failed to save index document {ref_string}")
        
        print("Processing complete!")

def main():
    # Configuration
    HOST = ""
    
    # Create processor and run
    processor = CouchDBProcessor(HOST)
    processor.process_tracks()

if __name__ == "__main__":
    main()