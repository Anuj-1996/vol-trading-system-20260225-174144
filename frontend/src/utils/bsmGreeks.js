// Utility: Black-Scholes-Merton Greeks calculator (ported from MarketPage.jsx)
export function bsmGreeks(S, K, T, sigma, r, isCall) {
  if (!S||!K||T<=0||sigma<=0) return null;
  const sq=Math.sqrt(T);
  const d1=(Math.log(S/K)+(r+0.5*sigma*sigma)*T)/(sigma*sq);
  const d2=d1-sigma*sq;
  const Nd1=ncdf(d1), Nd2=ncdf(d2), nd1=npdf(d1), DF=Math.exp(-r*T);
  const rhoRaw = isCall ? (K * T * DF * Nd2) / 100 : (-K * T * DF * (1 - Nd2)) / 100;
  return {
    iv: sigma*100,
    delta: Math.abs(isCall ? Nd1 : Nd1-1),
    gamma: nd1/(S*sigma*sq),
    theta: Math.abs((isCall ? -S*nd1*sigma/(2*sq)-r*K*DF*Nd2 : -S*nd1*sigma/(2*sq)+r*K*DF*(1-Nd2))/365),
    rho: Math.abs(rhoRaw),
    vega:  S*nd1*sq/100,
    price: isCall ? S*Nd1-K*DF*Nd2 : K*DF*(1-Nd2)-S*(1-Nd1),
  };
}

// Standard normal CDF
function ncdf(x) {
  return (1 + erf(x / Math.sqrt(2))) / 2;
}
// Standard normal PDF
function npdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}
// Error function
function erf(x) {
  // Abramowitz and Stegun formula 7.1.26
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
