import { File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import { htmlEscape } from './format';

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

export async function sharePdf(title: string, bodyHtml: string): Promise<void> {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: -apple-system, Roboto, Arial, sans-serif; color: #1f2937; padding: 24px; font-size: 12px; }
    h1 { color: #1e3a8a; font-size: 20px; margin: 0 0 4px; }
    h2 { font-size: 14px; margin: 18px 0 6px; }
    .muted { color: #6b7280; }
    table { width: 100%; border-collapse: collapse; margin-top: 6px; }
    th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid #e5e7eb; }
    th { background: #f3f4f6; }
    td.num, th.num { text-align: right; }
  </style></head><body><h1>${htmlEscape(title)}</h1>${bodyHtml}</body></html>`;
  if (Platform.OS === 'web') {
    await Print.printAsync({ html });
    return;
  }
  const { uri } = await Print.printToFileAsync({ html });
  await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: title, UTI: 'com.adobe.pdf' });
}
