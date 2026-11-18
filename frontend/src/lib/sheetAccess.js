import { createContext, useContext } from 'react';

/** Whether the signed-in Google account can open the configured spreadsheet. While it cannot, the app is limited to Settings. */
export const SheetAccessContext = createContext({ denied: false, message: '', recheck: async () => {} });
export const useSheetAccess = () => useContext(SheetAccessContext);
