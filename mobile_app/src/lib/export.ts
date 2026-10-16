import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import type { PdfReport } from './pdf';

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
}

export async function shareCsv(filename: string, csv: string): Promise<void> {
  const name = safeName(filename.endsWith('.csv') ? filename : `${filename}.csv`);
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    return;
  }
  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.create();
  file.write('\uFEFF' + csv); // BOM so Excel opens UTF-8 correctly
  await Sharing.shareAsync(file.uri, { mimeType: 'text/csv', dialogTitle: name, UTI: 'public.comma-separated-values-text' });
}

/** Downloads a written PDF. On the web this is a file, not a print of the screen. */
export async function sharePdf(filename: string, report: PdfReport): Promise<void> {
  const name = safeName(filename.endsWith('.pdf') ? filename : `${filename}.pdf`);
  const { buildPdf } = await import('./pdf');
  const bytes = await buildPdf(report);
  if (Platform.OS === 'web') {
    const copy = new Uint8Array(bytes);
    const url = URL.createObjectURL(new Blob([copy], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    return;
  }
  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.create();
  file.write(bytes);
  await Sharing.shareAsync(file.uri, { mimeType: 'application/pdf', dialogTitle: report.title, UTI: 'com.adobe.pdf' });
}
