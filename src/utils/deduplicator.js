export function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/university|deemed|institute|of|technology|science|arts|the/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

export function isDuplicate(name, existingNames) {
  const normalized = normalizeName(name);
  return existingNames.some(existing => {
    const normalizedExisting = normalizeName(existing);
    return normalizedExisting === normalized ||
      normalizedExisting.includes(normalized) ||
      normalized.includes(normalizedExisting);
  });
}
