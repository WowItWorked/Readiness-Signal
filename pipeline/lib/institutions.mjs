// Named financial institutions for the SPEC §6 lint (validation questions, issue statements and
// awareness rationales must not name a specific institution) and as a stage-1 sector signal.
//
// Heuristic by design. Aliases match case-insensitively on word boundaries, except aliases marked
// { cs: true }, which match case-sensitively because the lowercase form is an ordinary English word
// ("swift", "chase", "state street") or a common abbreviation. An alias written 're:<regex>' is a
// raw pattern (still bounded by word boundaries), used where a lookahead must rule out a
// supervisor or an everyday phrase ("Prudential Regulation Authority"). Ambiguous everyday words are only
// listed in disambiguated form ("Ally Financial", "Discover Financial", "Nationwide Building
// Society"). Regulators and central banks are deliberately absent: naming a supervisor's
// expectation is not naming an institution's position.

const cs = (alias) => ({ alias, cs: true });

export const INSTITUTIONS = [
  // United States: banks
  { name: 'JPMorgan Chase', aliases: ['JPMorgan Chase', 'JPMorgan', 'J.P. Morgan', 'JP Morgan', 'JPMC', cs('JPM'), cs('re:Chase(?!\\s+(?:the|a|an|down|after|up|it|them|this|that|these|those|alerts?|tickets?)(?![\\p{L}\\p{N}]))')] },
  { name: 'Bank of America', aliases: ['Bank of America', 'BofA', cs('BoA'), 'Merrill Lynch'] },
  { name: 'Citigroup', aliases: ['Citigroup', 'Citibank', 'Citi'] },
  { name: 'Wells Fargo', aliases: ['Wells Fargo'] },
  { name: 'Goldman Sachs', aliases: ['Goldman Sachs', cs('Goldman')] },
  { name: 'Morgan Stanley', aliases: ['Morgan Stanley'] },
  { name: 'U.S. Bancorp', aliases: ['U.S. Bancorp', 'US Bancorp', cs('U.S. Bank'), cs('US Bank')] },
  { name: 'PNC Financial', aliases: ['PNC Financial', 'PNC Bank', cs('PNC')] },
  { name: 'Truist', aliases: ['Truist'] },
  { name: 'Capital One', aliases: ['Capital One', cs('Cap One')] },
  { name: 'TD Bank', aliases: ['TD Bank', 'TD Securities', 'Toronto-Dominion'] },
  { name: 'BNY', aliases: ['BNY Mellon', 'Bank of New York Mellon', cs('BNY')] },
  { name: 'State Street', aliases: [cs('State Street')] },
  { name: 'Northern Trust', aliases: ['Northern Trust'] },
  { name: 'Charles Schwab', aliases: ['Charles Schwab', 'Schwab'] },
  { name: 'Citizens Financial', aliases: ['Citizens Financial', cs('Citizens Bank')] },
  { name: 'Fifth Third', aliases: ['Fifth Third'] },
  { name: 'KeyCorp', aliases: ['KeyCorp', 'KeyBank'] },
  { name: 'Huntington Bancshares', aliases: ['Huntington Bancshares', 'Huntington National Bank', cs('Huntington Bank')] },
  { name: 'M&T Bank', aliases: ['M&T Bank', cs('M&T')] },
  { name: 'Regions Financial', aliases: ['Regions Financial', cs('Regions Bank')] },
  { name: 'First Citizens BancShares', aliases: ['First Citizens BancShares', 'First Citizens Bank', cs('First Citizens')] },
  { name: 'Silicon Valley Bank', aliases: ['Silicon Valley Bank', cs('SVB')] },
  { name: 'First Republic', aliases: ['First Republic Bank', cs('First Republic')] },
  { name: 'Signature Bank', aliases: ['Signature Bank'] },
  { name: 'Synchrony', aliases: ['Synchrony Financial', 'Synchrony Bank', cs('Synchrony')] },
  { name: 'Discover Financial', aliases: ['Discover Financial', 'Discover Bank', cs('Discover Card')] },
  { name: 'Ally Financial', aliases: ['Ally Financial', 'Ally Bank'] },
  { name: 'American Express', aliases: ['American Express', 'Amex'] },
  { name: 'Navy Federal Credit Union', aliases: ['Navy Federal'] },
  { name: 'USAA', aliases: [cs('USAA')] },
  { name: 'Comerica', aliases: ['Comerica'] },
  { name: 'Zions Bancorporation', aliases: ['Zions Bancorporation', 'Zions Bank'] },
  { name: 'Western Alliance', aliases: ['Western Alliance Bancorporation', 'Western Alliance Bank'] },
  { name: 'Raymond James', aliases: ['Raymond James'] },
  { name: 'Jefferies', aliases: ['Jefferies'] },
  { name: 'Evolve Bank & Trust', aliases: ['Evolve Bank'] },
  { name: 'Flagstar', aliases: ['Flagstar'] },
  { name: 'Patelco Credit Union', aliases: ['Patelco'] },
  { name: 'Synapse Financial', aliases: ['Synapse Financial', 'Synapse Brokerage'] },
  { name: 'Edward Jones', aliases: ['Edward Jones'] },
  { name: 'LPL Financial', aliases: ['LPL Financial', cs('LPL')] },
  { name: 'Ameriprise', aliases: ['Ameriprise'] },
  { name: 'Interactive Brokers', aliases: ['Interactive Brokers'] },
  // Canada
  { name: 'Royal Bank of Canada', aliases: ['Royal Bank of Canada', cs('RBC')] },
  { name: 'Bank of Montreal', aliases: ['Bank of Montreal', cs('BMO')] },
  { name: 'Scotiabank', aliases: ['Scotiabank', 'Bank of Nova Scotia'] },
  { name: 'CIBC', aliases: [cs('CIBC'), 'Canadian Imperial Bank of Commerce'] },
  // United Kingdom and Ireland
  { name: 'HSBC', aliases: ['HSBC'] },
  { name: 'Barclays', aliases: ['Barclays', 'Barclaycard'] },
  { name: 'Lloyds Banking Group', aliases: ['Lloyds Banking Group', 'Lloyds Bank', cs('Lloyds')] },
  { name: 'NatWest', aliases: ['NatWest', 'Royal Bank of Scotland', cs('RBS')] },
  { name: 'Standard Chartered', aliases: ['Standard Chartered', 'StanChart'] },
  { name: 'Santander', aliases: ['Santander'] },
  { name: 'Nationwide Building Society', aliases: ['Nationwide Building Society'] },
  { name: 'Virgin Money', aliases: ['Virgin Money'] },
  { name: 'Metro Bank', aliases: ['Metro Bank'] },
  { name: 'TSB', aliases: [cs('TSB')] },
  { name: 'Monzo', aliases: ['Monzo'] },
  { name: 'Starling Bank', aliases: ['Starling Bank'] },
  { name: 'Revolut', aliases: ['Revolut'] },
  { name: 'Wise', aliases: ['Wise plc', cs('TransferWise')] },
  { name: 'Halifax', aliases: [cs('Halifax Bank'), 'Bank of Scotland'] },
  { name: 'Coutts', aliases: ['Coutts'] },
  { name: 'Bank of Ireland', aliases: ['Bank of Ireland'] },
  { name: 'AIB', aliases: ['Allied Irish Banks', cs('AIB')] },
  // Euro area and wider Europe
  { name: 'BNP Paribas', aliases: ['BNP Paribas', cs('BNP')] },
  { name: 'Société Générale', aliases: ['Société Générale', 'Societe Generale', 'SocGen'] },
  { name: 'Crédit Agricole', aliases: ['Crédit Agricole', 'Credit Agricole'] },
  { name: 'Natixis', aliases: ['Natixis', 'BPCE'] },
  // Bare "Deutsche" usually means the bank; not the exchange, the central bank or non-financial firms.
  { name: 'Deutsche Bank', aliases: ['Deutsche Bank', cs('re:Deutsche(?!\\s+(?:Börse|Boerse|Bundesbank|Telekom|Bahn|Post|Welle|Lufthansa|Pfandbriefbank|Rentenversicherung))')] },
  { name: 'Commerzbank', aliases: ['Commerzbank'] },
  { name: 'UniCredit', aliases: ['UniCredit'] },
  { name: 'Intesa Sanpaolo', aliases: ['Intesa Sanpaolo', cs('Intesa')] },
  { name: 'BBVA', aliases: [cs('BBVA')] },
  { name: 'CaixaBank', aliases: ['CaixaBank'] },
  { name: 'ING', aliases: ['ING Group', 'ING Bank', cs('ING')] },
  { name: 'Rabobank', aliases: ['Rabobank'] },
  { name: 'ABN AMRO', aliases: ['ABN AMRO'] },
  { name: 'KBC', aliases: ['KBC Group', cs('KBC')] },
  { name: 'Nordea', aliases: ['Nordea'] },
  { name: 'Danske Bank', aliases: ['Danske Bank'] },
  { name: 'SEB', aliases: ['Skandinaviska Enskilda', cs('SEB')] },
  { name: 'Handelsbanken', aliases: ['Handelsbanken'] },
  { name: 'Swedbank', aliases: ['Swedbank'] },
  { name: 'DNB', aliases: ['DNB Bank', cs('DNB')] },
  { name: 'Erste Group', aliases: ['Erste Group', 'Erste Bank'] },
  { name: 'Raiffeisen Bank International', aliases: ['Raiffeisen'] },
  { name: 'UBS', aliases: [cs('UBS')] },
  { name: 'Credit Suisse', aliases: ['Credit Suisse'] },
  { name: 'Julius Baer', aliases: ['Julius Baer', 'Julius Bär'] },
  { name: 'N26', aliases: [cs('N26')] },
  { name: 'Bunq', aliases: ['bunq'] },
  // Asia-Pacific and other global banks
  { name: 'Mitsubishi UFJ Financial Group', aliases: ['Mitsubishi UFJ', cs('MUFG')] },
  { name: 'Mizuho', aliases: ['Mizuho'] },
  { name: 'Sumitomo Mitsui', aliases: ['Sumitomo Mitsui', cs('SMBC')] },
  { name: 'Nomura', aliases: ['Nomura'] },
  { name: 'ICBC', aliases: ['Industrial and Commercial Bank of China', cs('ICBC')] },
  { name: 'Bank of China', aliases: ['Bank of China'] },
  { name: 'China Construction Bank', aliases: ['China Construction Bank'] },
  { name: 'Agricultural Bank of China', aliases: ['Agricultural Bank of China'] },
  { name: 'DBS', aliases: ['DBS Bank', cs('DBS')] },
  { name: 'OCBC', aliases: [cs('OCBC')] },
  { name: 'UOB', aliases: ['United Overseas Bank', cs('UOB')] },
  { name: 'ANZ', aliases: [cs('ANZ')] },
  { name: 'Westpac', aliases: ['Westpac'] },
  { name: 'National Australia Bank', aliases: ['National Australia Bank', cs('NAB')] },
  { name: 'Commonwealth Bank', aliases: ['Commonwealth Bank', cs('CBA')] },
  { name: 'Macquarie', aliases: ['Macquarie'] },
  { name: 'HDFC Bank', aliases: ['HDFC Bank', cs('HDFC')] },
  { name: 'ICICI Bank', aliases: ['ICICI'] },
  { name: 'State Bank of India', aliases: ['State Bank of India'] },
  { name: 'Itaú Unibanco', aliases: ['Itaú', 'Itau Unibanco'] },
  { name: 'Bradesco', aliases: ['Bradesco'] },
  { name: 'Banco do Brasil', aliases: ['Banco do Brasil'] },
  { name: 'Nubank', aliases: ['Nubank', 'Nu Holdings'] },
  // Card networks, payment firms and fintech
  { name: 'Visa', aliases: ['Visa Inc', cs('Visa')] },
  { name: 'Mastercard', aliases: ['Mastercard'] },
  { name: 'UnionPay', aliases: ['UnionPay'] },
  { name: 'JCB', aliases: [cs('JCB')] },
  { name: 'PayPal', aliases: ['PayPal', 'Venmo'] },
  { name: 'Zelle', aliases: ['Zelle', 'Early Warning Services'] },
  { name: 'Stripe', aliases: [cs('Stripe')] },
  { name: 'Adyen', aliases: ['Adyen'] },
  { name: 'Worldpay', aliases: ['Worldpay'] },
  { name: 'Fiserv', aliases: ['Fiserv'] },
  { name: 'FIS', aliases: ['Fidelity National Information Services', cs('FIS')] },
  { name: 'Global Payments', aliases: ['Global Payments Inc', cs('Global Payments')] },
  { name: 'Jack Henry', aliases: ['Jack Henry'] },
  { name: 'Worldline', aliases: ['Worldline'] },
  { name: 'Nexi', aliases: ['Nexi'] },
  { name: 'Klarna', aliases: ['Klarna'] },
  { name: 'Affirm', aliases: ['Affirm Holdings'] },
  { name: 'Block', aliases: ['Block Inc', 'Cash App'] },
  { name: 'SoFi', aliases: ['SoFi'] },
  { name: 'Robinhood', aliases: ['Robinhood'] },
  { name: 'Chime', aliases: ['Chime Financial', cs('Chime')] },
  { name: 'Marqeta', aliases: ['Marqeta'] },
  { name: 'TSYS', aliases: [cs('TSYS'), 'Total System Services'] },
  { name: 'Finastra', aliases: ['Finastra'] },
  { name: 'Broadridge', aliases: ['Broadridge'] },
  { name: 'Pershing', aliases: [cs('Pershing')] },
  { name: 'eToro', aliases: ['eToro'] },
  { name: 'Coinbase', aliases: ['Coinbase'] },
  { name: 'Binance', aliases: ['Binance'] },
  // Crypto-asset exchanges, custodians and stablecoin issuers. "Kraken" is also a malware family.
  { name: 'Bybit', aliases: ['Bybit'] },
  { name: 'Bitget', aliases: ['Bitget'] },
  { name: 'HTX', aliases: ['Huobi', cs('HTX')] },
  { name: 'Bithumb', aliases: ['Bithumb'] },
  { name: 'Gate.io', aliases: ['Gate.io'] },
  { name: 'MEXC', aliases: [cs('MEXC')] },
  { name: 'Phemex', aliases: ['Phemex'] },
  { name: 'CoinDCX', aliases: ['CoinDCX'] },
  { name: 'BingX', aliases: ['BingX'] },
  { name: 'Poloniex', aliases: ['Poloniex'] },
  { name: 'Kraken', aliases: [cs('re:Kraken(?!\\s+(?:botnet|malware|ransomware|Cryptor|cryptor|stealer|loader|RAT|crypter|group|gang|operators?|affiliates?)(?![\\p{L}\\p{N}]))')] },
  { name: 'Crypto.com', aliases: ['Crypto.com'] },
  { name: 'OKX', aliases: [cs('OKX')] },
  { name: 'Bitstamp', aliases: ['Bitstamp'] },
  { name: 'Bitfinex', aliases: ['Bitfinex'] },
  { name: 'KuCoin', aliases: ['KuCoin'] },
  { name: 'Upbit', aliases: ['Upbit'] },
  { name: 'WazirX', aliases: ['WazirX'] },
  { name: 'DMM Bitcoin', aliases: ['DMM Bitcoin'] },
  { name: 'Coincheck', aliases: ['Coincheck'] },
  { name: 'Tether', aliases: [cs('Tether')] },
  { name: 'Paxos', aliases: ['Paxos'] },
  { name: 'BitGo', aliases: ['BitGo'] },
  { name: 'Anchorage Digital', aliases: ['Anchorage Digital'] },
  { name: 'Ant Group', aliases: ['Ant Group', 'Alipay'] },
  { name: 'Paytm', aliases: ['Paytm'] },
  { name: 'PhonePe', aliases: ['PhonePe'] },
  { name: 'WeChat Pay', aliases: ['WeChat Pay'] },
  { name: 'Equifax', aliases: ['Equifax'] },
  { name: 'Experian', aliases: ['Experian'] },
  { name: 'TransUnion', aliases: ['TransUnion'] },
  // Market infrastructures and exchanges
  // Title-case "Swift" (the post-2023 brand) only where it is plainly the network, never "a Swift response".
  // A market infrastructure's own product names it (FILTER V4): 3SKey is SWIFT's personal token.
  { name: 'SWIFT', aliases: [cs('SWIFT'), cs('3SKey'), 'Society for Worldwide Interbank', cs("re:Swift(?=(?:'s)?\\s+(?:network|messaging|messages?|CSP|CSCF|gpi|GPI|Customer\\s+Security|codes?|BIC|connectivity|members?|users?|community|infrastructure|platform|transfers?|payments?|system|Alliance|ISO\\s*20022|MT\\s*\\d|MX)(?![\\p{L}\\p{N}]))")] },
  { name: 'DTCC', aliases: [cs('DTCC'), 'Depository Trust'] },
  { name: 'Euroclear', aliases: ['Euroclear'] },
  { name: 'Clearstream', aliases: ['Clearstream'] },
  { name: 'LCH', aliases: ['LCH Group', 'LCH.Clearnet', cs('LCH')] },
  { name: 'CLS Group', aliases: ['CLS Group', 'CLS Bank'] },
  { name: 'CME Group', aliases: ['CME Group', 'Chicago Mercantile Exchange'] },
  { name: 'Intercontinental Exchange', aliases: ['Intercontinental Exchange', cs('NYSE')] },
  { name: 'Nasdaq', aliases: ['Nasdaq'] },
  { name: 'Cboe', aliases: ['Cboe'] },
  { name: 'London Stock Exchange Group', aliases: ['London Stock Exchange', cs('LSEG')] },
  { name: 'Deutsche Börse', aliases: ['Deutsche Börse', 'Deutsche Boerse'] },
  { name: 'Euronext', aliases: ['Euronext'] },
  { name: 'Hong Kong Exchanges and Clearing', aliases: ['Hong Kong Exchanges', cs('HKEX')] },
  // CHIPS is The Clearing House's payment system; the "CHIPS Act" is US semiconductor law.
  { name: 'The Clearing House', aliases: [cs('The Clearing House'), cs('re:CHIPS(?!\\s+(?:Act|and\\s+Science)(?![\\p{L}\\p{N}]))')] },
  { name: 'Options Clearing Corporation', aliases: ['Options Clearing Corporation'] },
  { name: 'Citadel Securities', aliases: ['Citadel Securities'] },
  // Insurers, reinsurers and brokers
  { name: 'AIG', aliases: ['American International Group', cs('AIG')] },
  { name: 'Allianz', aliases: ['Allianz'] },
  { name: 'AXA', aliases: [cs('AXA'), 'AXA XL'] },
  { name: 'Zurich Insurance', aliases: ['Zurich Insurance'] },
  { name: 'Generali', aliases: ['Generali'] },
  { name: 'Chubb', aliases: ['Chubb'] },
  { name: 'MetLife', aliases: ['MetLife'] },
  // The insurer, not the adjective or a supervisor ("Prudential Regulation Authority", "Prudential
  // standards"): title-case "Prudential" unless a regulatory noun follows.
  { name: 'Prudential', aliases: ['Prudential Financial', 'Prudential plc', cs('Prudential Insurance'), cs('re:Prudential(?!\\s+(?:Regulation|Regulatory|Authority|Committee|Supervision|Supervisory|Standards?|Sourcebook|regulat\\w*|supervis\\w*|standards?|requirements?|rules?|limits?|ratios?|treatment|frameworks?|risks?|polic\\w*|measures?|oversight|approach\\w*|judge?ments?|valuation|capital|liquidity|buffers?|expectations?|regime|sourcebooks?|reasons?|matters?|purposes?|grounds?|perspective|concerns?|reporting|returns?|data|filters?|consolidation|scope|level|and|or)(?![\\p{L}\\p{N}]))')] },
  { name: 'Aviva', aliases: ['Aviva'] },
  { name: 'Legal & General', aliases: ['Legal & General', 'Legal and General'] },
  { name: 'Munich Re', aliases: ['Munich Re'] },
  { name: 'Swiss Re', aliases: ['Swiss Re'] },
  { name: 'Hannover Re', aliases: ['Hannover Re'] },
  { name: "Lloyd's of London", aliases: ["Lloyd's of London", "Lloyd's"] },
  { name: 'Berkshire Hathaway', aliases: ['Berkshire Hathaway'] },
  { name: 'Allstate', aliases: ['Allstate'] },
  { name: 'State Farm', aliases: ['State Farm'] },
  { name: 'Travelers', aliases: ['Travelers Companies', cs('Travelers Insurance')] },
  { name: 'Liberty Mutual', aliases: ['Liberty Mutual'] },
  { name: 'Nationwide Mutual', aliases: ['Nationwide Mutual', 'Nationwide Insurance'] },
  { name: 'Manulife', aliases: ['Manulife', 'John Hancock Financial'] },
  { name: 'Sun Life', aliases: ['Sun Life Financial'] },
  { name: 'Ping An', aliases: ['Ping An'] },
  { name: 'AIA Group', aliases: ['AIA Group'] },
  { name: 'Tokio Marine', aliases: ['Tokio Marine'] },
  { name: 'Beazley', aliases: ['Beazley'] },
  { name: 'Hiscox', aliases: ['Hiscox'] },
  { name: 'Aon', aliases: [cs('Aon'), cs('AON')] },
  { name: 'Marsh McLennan', aliases: ['Marsh McLennan', 'Marsh & McLennan'] },
  { name: 'WTW', aliases: ['Willis Towers Watson'] },
  // Asset managers and investment firms
  { name: 'BlackRock', aliases: ['BlackRock'] },
  { name: 'Vanguard Group', aliases: ['Vanguard Group', cs('Vanguard')] },
  { name: 'Fidelity Investments', aliases: ['Fidelity Investments', 'Fidelity International'] },
  { name: 'Invesco', aliases: ['Invesco'] },
  { name: 'T. Rowe Price', aliases: ['T. Rowe Price', 'T Rowe Price'] },
  { name: 'Franklin Templeton', aliases: ['Franklin Templeton'] },
  { name: 'PIMCO', aliases: ['PIMCO'] },
  { name: 'Amundi', aliases: ['Amundi'] },
  { name: 'Blackstone', aliases: ['Blackstone'] },
  { name: 'KKR', aliases: [cs('KKR')] },
  { name: 'Apollo Global Management', aliases: ['Apollo Global'] },
  { name: 'Bridgewater Associates', aliases: ['Bridgewater Associates'] },
];

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}_])';
const BOUNDARY_AFTER = '(?![\\p{L}\\p{N}_])';

function aliasPattern(alias) {
  // 're:<regex>' is a raw pattern (lookaheads disambiguate everyday words); text after a curly
  // apostrophe has already been straightened by findInstitutions.
  if (alias.startsWith('re:')) return alias.slice(3);
  // Flexible whitespace.
  return reEscape(alias).replace(/\s+/g, '\\s+');
}

const COMPILED = INSTITUTIONS.flatMap(({ name, aliases }) =>
  aliases.map((a) => {
    const alias = typeof a === 'string' ? a : a.alias;
    const caseSensitive = typeof a === 'object' && a.cs === true;
    return {
      name,
      alias,
      re: new RegExp(`${BOUNDARY_BEFORE}${aliasPattern(alias)}${BOUNDARY_AFTER}`, caseSensitive ? 'gu' : 'giu'),
    };
  }),
);

/** All institution mentions in `text`: [{ name, alias, match, index }]. */
export function findInstitutions(text) {
  if (!text) return [];
  const s = String(text).replace(/\u2019/g, "'");
  const out = [];
  for (const { name, alias, re } of COMPILED) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) {
      out.push({ name, alias, match: m[0], index: m.index });
      if (!re.global) break;
    }
  }
  // de-duplicate overlapping mentions of the same institution
  const seen = new Set();
  return out
    .sort((a, b) => a.index - b.index || b.match.length - a.match.length)
    .filter((m) => {
      const key = `${m.name}@${m.index}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function institutionCount() {
  return INSTITUTIONS.length;
}
