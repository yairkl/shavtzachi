import os
import json
import sys

print("DEPRECATED: Shavtzachi now handles authentication directly in the application.")
print("Please open the app in your browser to sign in.")
print("If you still need to use this script for some reason, please check the source code.")
# sys.exit(0) # Keep it runnable if they really want, but warn heavily

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']

def main():
    creds = None
    if os.path.exists('token.json'):
        creds = Credentials.from_authorized_user_file('token.json', SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file('credentials.json', SCOPES)
            creds = flow.run_local_server(port=0)
        with open('token.json', 'w') as token:
            token.write(creds.to_json())

    service = build('sheets', 'v4', credentials=creds)

    config_file = 'config.json'
    config = {}
    if os.path.exists(config_file):
        with open(config_file, 'r') as f:
            config = json.load(f)

    # 1. Setup Input Tracker
    if not config.get('INPUT_SPREADSHEET_ID'):
        print("Creating 'Shavtzachi Tracker' Spreadsheet...")
        spreadsheet = {
            'properties': {'title': 'Shavtzachi Tracker'},
            'sheets': [
                {'properties': {'title': 'Soldiers'}, 'data': [{'rowData': [{'values': [{'userEnteredValue': {'stringValue': 'Name'}}, {'userEnteredValue': {'stringValue': 'Division'}}, {'userEnteredValue': {'stringValue': 'Skills'}}, {'userEnteredValue': {'stringValue': 'Excluded Posts'}}]}]}]},
                {'properties': {'title': 'Posts'}, 'data': [{'rowData': [{'values': [{'userEnteredValue': {'stringValue': 'Name'}}, {'userEnteredValue': {'stringValue': 'Shift Length (hrs)'}}, {'userEnteredValue': {'stringValue': 'Start Time'}}, {'userEnteredValue': {'stringValue': 'End Time'}}, {'userEnteredValue': {'stringValue': 'Cooldown (hrs)'}}, {'userEnteredValue': {'stringValue': 'Intensity Weight'}}, {'userEnteredValue': {'stringValue': 'Slots'}}]}]}]},
                {'properties': {'title': 'Unavailabilities'}, 'data': [{'rowData': [{'values': [{'userEnteredValue': {'stringValue': 'Soldier Name'}}, {'userEnteredValue': {'stringValue': 'Start DateTime'}}, {'userEnteredValue': {'stringValue': 'End DateTime'}}, {'userEnteredValue': {'stringValue': 'Reason'}}]}]}]},
                {'properties': {'title': 'Skills'}, 'data': [{'rowData': [{'values': [{'userEnteredValue': {'stringValue': 'Name'}}]}]}]}
            ]
        }
        res = service.spreadsheets().create(body=spreadsheet, fields='spreadsheetId').execute()
        config['INPUT_SPREADSHEET_ID'] = res.get('spreadsheetId')
        print(f"Input Spreadsheet created with ID: {config['INPUT_SPREADSHEET_ID']}")
        print(f"URL: https://docs.google.com/spreadsheets/d/{config['INPUT_SPREADSHEET_ID']}")

    # 2. Setup Output Schedules
    if not config.get('OUTPUT_SPREADSHEET_ID'):
        print("Creating 'Shavtzachi Schedules' Spreadsheet...")
        spreadsheet = {
            'properties': {'title': 'Shavtzachi Schedules'}
        }
        res = service.spreadsheets().create(body=spreadsheet, fields='spreadsheetId').execute()
        config['OUTPUT_SPREADSHEET_ID'] = res.get('spreadsheetId')
        print(f"Output Spreadsheet created with ID: {config['OUTPUT_SPREADSHEET_ID']}")
        print(f"URL: https://docs.google.com/spreadsheets/d/{config['OUTPUT_SPREADSHEET_ID']}")

    with open(config_file, 'w') as f:
        json.dump(config, f)
    
    print("Setup complete! You can now close this terminal.")

if __name__ == '__main__':
    main()
