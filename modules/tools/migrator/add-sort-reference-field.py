import requests
from requests.auth import HTTPBasicAuth

DB_URL = 'https://couchdb.shruti.app/tracks'  # Replace with your database URL
DB_USERNAME = ''
DB_PASSWORD = ''

def format_sort_reference(ref_array):
    if not ref_array:
        return "\uffff" 
    
    prefix = ref_array[0]
    numeric_parts = [f"{x:04d}" if isinstance(x, int) else str(x).zfill(4) for x in ref_array[1:]]
    return f"{prefix} {'.'.join(numeric_parts)}"
                    

def format_sort_date(date_array):
    if not date_array:
      return "00000000" 
    year  = str(date_array[0]).zfill(4) if date_array else "0000"
    month = str(date_array[1]).zfill(2) if len(date_array) > 1 else "00"
    day   = str(date_array[2]).zfill(2) if len(date_array) > 2 else "00"
    return f"{year}{month}{day}"

def process_documents():
    try:
        auth = HTTPBasicAuth(DB_USERNAME, DB_PASSWORD)
        response = requests.get(f'{DB_URL}/_all_docs?include_docs=true', auth=auth, verify=False)
        response.raise_for_status()  # Raise an error for bad status codes
        docs = response.json()['rows']
        
        for doc in docs:
            doc_data = doc['doc']
            changes_made = False
            
            first_ref = (doc_data.get('references', [[]]) or [[]])[0]
            sort_ref   = format_sort_reference(first_ref)
            sort_date = format_sort_date(doc_data.get('date', []))
            changes_made = (
                doc_data['sort_reference'] != sort_ref or 
                doc_data['sort_date'] != sort_date)

            doc_data['sort_reference'] = sort_ref
            doc_data['sort_date'] = sort_date

            if changes_made:
              print(doc_data['sort_reference'], doc_data["sort_date"])
              update_response = requests.put(
                  f"{DB_URL}/{doc_data['_id']}",
                  auth=auth,
                  json=doc_data,
                  headers={'Content-Type': 'application/json'},
                  verify=False
              )
              update_response.raise_for_status()
                
    except requests.exceptions.RequestException as e:
        print(f"An error occurred: {str(e)}")

# Execute the document processing
if __name__ == "__main__":
    process_documents()