// Never log provider messages, URLs, stacks or credentials. Only allowlisted classifications.
export function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (/fixed plan limits|plan.*limit/.test(message)) return 'storage_plan_limit';
  if (/max.*(request|command)|request.*limit|quota|daily.*limit/.test(message)) return 'storage_quota';
  if (/max.*(size|memory)|too large|memory.*limit|payload.*size/.test(message)) return 'storage_size_limit';
  if (/unauthorized|wrongpass|invalid.*token|forbidden/.test(message)) return 'storage_auth';
  if (/fetch|network|timeout|econn|enotfound/.test(message)) return 'dependency_network';
  if (/json|unexpected token/.test(message)) return 'state_decode';
  if (/lease lost/.test(message)) return 'lease_lost';
  return 'unclassified_dependency_or_state';
}
export function reportFailure(operation: string, error: unknown) {
  const code = failureCode(error);
  let detail = (error instanceof Error ? error.message : 'Non-Error failure').split(/,? command was:/i)[0];
  for (const [name, value] of Object.entries(process.env)) {
    if (/TOKEN|SECRET|KEY|URL/.test(name) && value && value.length > 4) detail = detail.split(value).join('[redacted]');
  }
  detail = detail.replace(/https?:\/\/[^\s]+/gi, '[url]').replace(/[A-Za-z0-9_+/=-]{32,}/g, '[identifier]').slice(0, 300);
  console.error('Terminal operation failed', JSON.stringify({ operation, code, detail })); return code;
}
