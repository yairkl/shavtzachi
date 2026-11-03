/** Turn an axios/Google API error into a message a user can act on. */
export function describeError(err, fallback = 'Something went wrong.') {
  if (!err) return fallback;
  const status = err.response?.status;
  const detail = err.response?.data?.error?.message;

  if (!err.response && (err.code === 'ERR_NETWORK' || err.request)) {
    return 'Could not reach Google. Check your internet connection and try again.';
  }
  switch (status) {
    case 401:
      return 'Your Google session expired. Reconnect and try again.';
    case 403:
      return /quota|rate/i.test(detail || '')
        ? 'Google is rate-limiting requests. Wait a minute and try again.'
        : 'You do not have permission to edit this spreadsheet. Ask the owner for edit access.';
    case 404:
      return 'The spreadsheet was not found. It may have been deleted or your Google account has no access. Choose another one in Settings.';
    case 429:
      return 'Google is rate-limiting requests. Wait a minute and try again.';
    case 400:
      return `Google could not process the request${detail ? `: ${detail}` : '.'}`;
    default:
      if (status >= 500) return 'Google had a temporary problem. Try again in a moment.';
  }
  return err.message || fallback;
}
