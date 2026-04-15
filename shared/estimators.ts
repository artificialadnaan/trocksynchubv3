export type EstimatorOption = {
  name: string;
  email: string;
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

export function sanitizeEstimatorList(
  estimators: Array<Partial<EstimatorOption>>,
): EstimatorOption[] {
  return estimators.map((estimator) => ({
    name: String(estimator?.name ?? "").trim(),
    email: String(estimator?.email ?? "").trim().toLowerCase(),
  }));
}

export function validateEstimatorList(
  estimators: Array<Partial<EstimatorOption>>,
): string[] {
  const sanitized = sanitizeEstimatorList(estimators);
  const errors: string[] = [];
  const seenNames = new Set<string>();
  const seenEmails = new Set<string>();

  sanitized.forEach((estimator, index) => {
    const rowNumber = index + 1;
    const normalizedName = estimator.name.toLowerCase();
    const normalizedEmail = estimator.email.toLowerCase();

    if (!estimator.name) {
      errors.push(`Estimator ${rowNumber} is missing a name.`);
    } else if (seenNames.has(normalizedName)) {
      errors.push(`Estimator ${rowNumber} has a duplicate name: "${estimators[index]?.name ?? estimator.name}".`);
    } else {
      seenNames.add(normalizedName);
    }

    if (!estimator.email) {
      errors.push(`Estimator ${rowNumber} is missing an email.`);
    } else if (!EMAIL_REGEX.test(estimator.email)) {
      errors.push(`Estimator ${rowNumber} has an invalid email address.`);
    } else if (seenEmails.has(normalizedEmail)) {
      errors.push(`Estimator ${rowNumber} has a duplicate email: "${estimators[index]?.email ?? estimator.email}".`);
    } else {
      seenEmails.add(normalizedEmail);
    }
  });

  return errors;
}
