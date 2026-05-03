import * as XLSX from 'xlsx';
import { format } from 'date-fns';

export const exportToExcel = (data, fileName) => {
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Schedule");
  XLSX.writeFile(wb, `${fileName}.xlsx`);
};

export const exportSoldiersToCSV = (soldiers) => {
    const csvContent = "data:text/csv;charset=utf-8," 
        + "Name,Division,Skills,Excluded Posts\n"
        + soldiers.map(s => `${s.name},${s.division || ""},"${s.skills.join(',')}","${s.excluded_posts.join(',')}"`).join("\n");
    
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "soldiers.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};
