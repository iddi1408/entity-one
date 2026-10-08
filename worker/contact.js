// Web3Forms form access keys are public recipient identifiers, not API secrets.
// Its free plan requires browser submissions; never proxy them through the Worker.
// Only accept the documented UUID format so another runtime secret cannot be
// accidentally exposed by a misconfigured environment value.
export function contactConfig(env) {
  const value = typeof env.WEB3FORMS_ACCESS_KEY === 'string' ? env.WEB3FORMS_ACCESS_KEY.trim() : '';
  const key = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) ? value : '';
  return {available: Boolean(key), key};
}
