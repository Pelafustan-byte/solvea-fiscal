export function normalizeRut(value) {
  const cleaned = String(value ?? '').toUpperCase().replace(/[^0-9K]/g, '');
  if (cleaned.length < 2) return '';
  return `${cleaned.slice(0, -1)}-${cleaned.slice(-1)}`;
}

export function isValidRut(value) {
  const rut = normalizeRut(value);
  if (!rut) return false;
  const [body, dv] = rut.split('-');
  if (!/^\d{6,8}$/.test(body)) return false;

  let sum = 0;
  let multiplier = 2;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    sum += Number(body[index]) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }
  const expectedNumber = 11 - (sum % 11);
  const expected = expectedNumber === 11 ? '0' : expectedNumber === 10 ? 'K' : String(expectedNumber);
  return expected === dv;
}
