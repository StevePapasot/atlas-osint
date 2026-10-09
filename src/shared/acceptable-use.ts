/**
 * Acceptable-use policy shown at /acceptable-use and accepted at registration. docs/ACCEPTABLE_USE.md mirrors this
 * text for readers of the repository (tests/unit/acceptable-use.test.ts keeps them in sync). Bump the version when the
 * rules change.
 */
export const ACCEPTABLE_USE_VERSION = 1;
export const ACCEPTABLE_USE_DATE = '9 October 2026';

export const ACCEPTABLE_USE = {
  intro:
    'ATLAS is for lawful, authorised research using publicly available information. It collects passively from public sources and never tries to access anything that is not public. These rules apply to everyone who uses an ATLAS instance.',
  appropriate: [
    'Due diligence, fraud and brand-protection investigations',
    'Threat intelligence and defensive security research',
    'Security assessments you are authorised to perform',
    'Journalism and academic research',
    'Reviewing your own or your organisation’s public exposure',
  ],
  must: [
    'Have a lawful basis and a legitimate purpose for every investigation, and record it in the scope statement.',
    'Comply with the laws that apply to you and to the people you research, including data-protection law such as the GDPR, and with the terms of every source and API you configure.',
    'Treat results as leads to verify, not as facts. Do not take action against a person based only on unverified findings.',
    'Protect the data you collect, keep it only as long as you need it (use the retention settings), and honour lawful requests from the people it concerns.',
  ],
  mustNot: [
    'Stalk, harass, intimidate, threaten or dox anyone, or locate or monitor a person without a lawful basis.',
    'Make decisions about employment, housing, credit, insurance or similar eligibility. ATLAS is not a background-check or consumer-reporting service.',
    'Access accounts, systems or data without authorisation, test or use credentials, or bypass access controls or rate limits.',
    'Obtain, buy, sell or trade stolen or leaked data.',
    'Target children, or collect sensitive data such as health, religion, political opinions or sexual orientation without a clear legal basis.',
    'Break the law or infringe anyone’s rights in any other way.',
  ],
  responsibility:
    'ATLAS is free software provided without warranty (see the licence, sections 15 and 16). Each instance is run by its own operator, and its users are responsible for how they use it. The ATLAS authors do not operate your instance, do not receive your data, and are not responsible for its use.',
} as const;
