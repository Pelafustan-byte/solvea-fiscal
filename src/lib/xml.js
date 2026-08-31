export function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function tag(name, value) {
  if (value === undefined || value === null || value === '') return '';
  return `<${name}>${escapeXml(value)}</${name}>`;
}
