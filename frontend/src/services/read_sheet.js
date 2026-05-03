import fs from 'fs';
import { google } from 'googleapis';
import path from 'path';

const config = JSON.parse(fs.readFileSync('../../config.json', 'utf8'));
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

const auth = new google.auth.GoogleAuth({
  keyFile: '../../credentials.json',
  scopes: SCOPES,
});

const sheets = google.sheets({ version: 'v4', auth });

async function read() {
  const SPREADSHEET_ID = config.SPREADSHEET_ID;
  const resp = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      includeGridData: true,
      ranges: ['Schedule!A:Z']
  });
  const sheet = resp.data.sheets[0];
  if (!sheet) return console.log("No Schedule sheet");
  const rowData = sheet.data[0].rowData || [];
  let foundNames = 0;
  for (let r = 0; r < rowData.length; r++) {
      const vals = rowData[r].values || [];
      for (let c = 0; c < vals.length; c++) {
          const val = vals[c]?.userEnteredValue?.stringValue;
          if (val && !['Date', 'Time'].includes(val) && !val.includes('/') && !val.includes(':') && !val.includes('Post') && !val.includes('Role')) {
              console.log(`Row ${r} Col ${c}: ${val}`);
              foundNames++;
          }
      }
  }
  console.log(`Total names found: ${foundNames}`);
}
read();
