import { readFileSync } from 'node:fs';

const h = readFileSync('index.html', 'utf8');
const count = (re) => (h.match(re) || []).length;
console.log('templates', count(/<template\b/g), count(/<\/template>/g));
console.log('divs', count(/<div\b/g), count(/<\/div>/g));
console.log('filter-toolbar', count(/filter-toolbar/g));
console.log('filterPanel', count(/id="patientFiltersPanel"/g));
console.log('toggle', count(/id="patientFiltersToggle"/g));
console.log('filter-chips', count(/class="filter-chips/g));
console.log('excel label', count(/t\('Excel export'\)/g));
