import * as XLSX from 'xlsx';
import { format, parseISO } from 'date-fns';

const toDate = (v) => (v instanceof Date ? v : typeof v === 'string' ? parseISO(v) : new Date(v));
const fmt = (v) => {
  const d = toDate(v);
  return Number.isNaN(d.getTime()) ? '' : format(d, 'yyyy-MM-dd HH:mm');
};

/** Rows for the schedule export. Accepts dates as Date objects or ISO strings. */
export function scheduleRows(assignments, posts = []) {
  const skillOf = (a) => posts.find((p) => p.name === a.post_name)?.slots?.find((s) => s.role_index === Number(a.role_id))?.skill ?? '';
  return [...assignments]
    .sort((a, b) => toDate(a.start) - toDate(b.start) || String(a.post_name).localeCompare(String(b.post_name)) || a.role_id - b.role_id)
    .map((a) => ({
      Start: fmt(a.start),
      End: fmt(a.end),
      Post: a.post_name,
      Role: skillOf(a) || `Role ${Number(a.role_id) + 1}`,
      Soldier: a.soldier_name,
    }));
}

/** Quote a CSV field when needed (commas, quotes, line breaks). */
const csvField = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function soldiersToCSV(soldiers) {
  const lines = [['Name', 'Division', 'Skills', 'Excluded Posts']];
  soldiers.forEach((s) => lines.push([s.name, s.division ?? '', (s.skills || []).join(', '), (s.excluded_posts || []).join(', ')]));
  return lines.map((row) => row.map(csvField).join(',')).join('\r\n');
}

function download(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const exportToExcel = (data, fileName, sheetName = 'Sheet1') => {
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, `${fileName}.xlsx`);
};

export const exportSoldiersToCSV = (soldiers) => {
  // BOM so Excel opens Hebrew text correctly.
  download(new Blob([`\uFEFF${soldiersToCSV(soldiers)}`], { type: 'text/csv;charset=utf-8' }), 'soldiers.csv');
};
