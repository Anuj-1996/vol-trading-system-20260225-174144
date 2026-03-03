// vol_core.cpp — High-performance C++ core for Heston MC, BS Greeks,
//                 payoff evaluation, and FFT pricing.
//
// Targets: Apple M4 (ARM64 NEON), compiled with -O3 -ffast-math.
// Bound to Python via pybind11.

#include <pybind11/pybind11.h>
#include <pybind11/numpy.h>
#include <pybind11/stl.h>

#include <cmath>
#include <complex>
#include <vector>
#include <algorithm>
#include <numeric>
#include <random>
#include <cstring>
#include <thread>
#include <mutex>

namespace py = pybind11;

// ═══════════════════════════════════════════════════════════════════════
// 1.  HESTON MONTE CARLO
// ═══════════════════════════════════════════════════════════════════════

struct HestonParams {
    double kappa, theta, xi, rho, v0;
};

// Single-threaded MC block — called by each worker thread
static void _heston_mc_block(
    const HestonParams& p,
    double spot,
    double maturity,
    double rate,
    int paths,
    int steps,
    uint64_t seed,
    double* out_terminal,       // size: paths
    double* out_price_paths,    // size: (steps+1)*paths  or nullptr
    double* out_vol_paths       // size: (steps+1)*paths  or nullptr
) {
    const double dt       = maturity / steps;
    const double sqrt_dt  = std::sqrt(dt);
    const double rho2     = std::sqrt(std::max(1.0 - p.rho * p.rho, 1e-12));

    std::mt19937_64 rng(seed);
    std::normal_distribution<double> norm(0.0, 1.0);

    for (int i = 0; i < paths; ++i) {
        double log_s = std::log(spot);
        double v     = p.v0;

        if (out_price_paths) out_price_paths[i] = spot;
        if (out_vol_paths)   out_vol_paths[i]   = v;

        for (int t = 1; t <= steps; ++t) {
            double z1 = norm(rng);
            double z2 = p.rho * z1 + rho2 * norm(rng);

            double v_clamp = std::max(v, 1e-12);
            double sqrt_v  = std::sqrt(v_clamp);

            v = v + p.kappa * (p.theta - v) * dt + p.xi * sqrt_v * sqrt_dt * z2;
            v = std::max(v, 1e-12);

            log_s = log_s + (rate - 0.5 * v_clamp) * dt + sqrt_v * sqrt_dt * z1;

            if (out_price_paths) out_price_paths[(size_t)t * paths + i] = std::exp(log_s);
            if (out_vol_paths)   out_vol_paths[(size_t)t * paths + i]   = v;
        }
        out_terminal[i] = std::exp(log_s);
    }
}

// Multi-threaded Heston MC simulation → returns (terminal, price_paths?, vol_paths?)
static py::tuple heston_mc(
    double kappa, double theta, double xi, double rho, double v0,
    double spot, double maturity, double rate,
    int paths, int steps, int seed, bool full_path
) {
    HestonParams p{kappa, theta, xi, rho, v0};

    // Determine thread count
    int n_threads = (int)std::thread::hardware_concurrency();
    if (n_threads < 1) n_threads = 1;
    if (paths < n_threads * 64) n_threads = 1;  // don't bother for tiny jobs

    auto terminal_arr = py::array_t<double>({(py::ssize_t)paths});
    auto* terminal_ptr = terminal_arr.mutable_data();

    py::array_t<double> price_paths_arr;
    py::array_t<double> vol_paths_arr;
    double* pp_ptr = nullptr;
    double* vp_ptr = nullptr;

    if (full_path) {
        price_paths_arr = py::array_t<double>({(py::ssize_t)(steps + 1), (py::ssize_t)paths});
        vol_paths_arr   = py::array_t<double>({(py::ssize_t)(steps + 1), (py::ssize_t)paths});
        pp_ptr = price_paths_arr.mutable_data();
        vp_ptr = vol_paths_arr.mutable_data();
    }

    if (n_threads == 1) {
        _heston_mc_block(p, spot, maturity, rate, paths, steps, (uint64_t)seed,
                         terminal_ptr, pp_ptr, vp_ptr);
    } else {
        std::vector<std::thread> threads;
        int chunk = paths / n_threads;
        int remainder = paths % n_threads;

        for (int tid = 0; tid < n_threads; ++tid) {
            int start = tid * chunk + std::min(tid, remainder);
            int count = chunk + (tid < remainder ? 1 : 0);
            uint64_t block_seed = (uint64_t)seed + tid * 999983ULL;

            double* t_out = terminal_ptr + start;
            double* p_out = pp_ptr ? pp_ptr + start : nullptr;
            double* v_out = vp_ptr ? vp_ptr + start : nullptr;

            // For full paths, each block writes to columns [start..start+count)
            // The stride is `paths` (row-major: shape=(steps+1, paths))
            threads.emplace_back([=, &p]() {
                // We need a temporary buffer and then copy into strided output
                // OR we can directly write with stride. Let's do direct writes.
                const double dt      = maturity / steps;
                const double sqrt_dt = std::sqrt(dt);
                const double rho2    = std::sqrt(std::max(1.0 - p.rho * p.rho, 1e-12));

                std::mt19937_64 rng(block_seed);
                std::normal_distribution<double> norm(0.0, 1.0);

                for (int i = 0; i < count; ++i) {
                    double log_s = std::log(spot);
                    double v     = p.v0;

                    if (p_out) p_out[(size_t)0 * paths + i] = spot;  // row 0, column start+i
                    if (v_out) v_out[(size_t)0 * paths + i] = v;

                    for (int t = 1; t <= steps; ++t) {
                        double z1 = norm(rng);
                        double z2 = p.rho * z1 + rho2 * norm(rng);

                        double v_clamp = std::max(v, 1e-12);
                        double sqrt_v  = std::sqrt(v_clamp);

                        v = v + p.kappa * (p.theta - v) * dt + p.xi * sqrt_v * sqrt_dt * z2;
                        v = std::max(v, 1e-12);

                        log_s = log_s + (rate - 0.5 * v_clamp) * dt + sqrt_v * sqrt_dt * z1;

                        if (p_out) p_out[(size_t)t * paths + i] = std::exp(log_s);
                        if (v_out) v_out[(size_t)t * paths + i] = v;
                    }
                    t_out[i] = std::exp(log_s);
                }
            });
        }
        for (auto& th : threads) th.join();
    }

    if (full_path) {
        return py::make_tuple(terminal_arr, price_paths_arr, vol_paths_arr);
    }
    return py::make_tuple(terminal_arr, py::none(), py::none());
}


// ═══════════════════════════════════════════════════════════════════════
// 2.  MULTI-LEG PAYOFF EVALUATION  (vectorized over terminal prices)
// ═══════════════════════════════════════════════════════════════════════

struct LegDef {
    double strike;
    int    option_type;  // 0 = Call, 1 = Put
    int    direction;    // +1 or -1
    int    ratio;
};

// Compute intrinsic payoff for all terminal prices  →  ndarray(n)
static py::array_t<double> intrinsic_payoff(
    py::array_t<double, py::array::c_style> terminal_prices,
    py::list py_legs
) {
    auto tp = terminal_prices.unchecked<1>();
    int n   = (int)tp.shape(0);

    // Parse legs
    std::vector<LegDef> legs;
    for (auto item : py_legs) {
        auto d = item.cast<py::dict>();
        LegDef leg;
        leg.strike      = d["strike"].cast<double>();
        leg.option_type  = (d["option_type"].cast<std::string>() == "C") ? 0 : 1;
        leg.direction    = d["direction"].cast<int>();
        leg.ratio        = d["ratio"].cast<int>();
        legs.push_back(leg);
    }

    auto result = py::array_t<double>({(py::ssize_t)n});
    double* out = result.mutable_data();
    std::memset(out, 0, sizeof(double) * n);

    for (const auto& leg : legs) {
        for (int i = 0; i < n; ++i) {
            double s = tp(i);
            double intr = (leg.option_type == 0)
                ? std::max(s - leg.strike, 0.0)
                : std::max(leg.strike - s, 0.0);
            out[i] += leg.direction * leg.ratio * intr;
        }
    }
    return result;
}

// Full strategy evaluation: payoff, PnL stats, VaR  →  dict
// Returns: {pnl, ev, var95, var99, es, prob_loss, max_loss, skew, kurtosis}
static py::dict evaluate_strategy(
    py::array_t<double, py::array::c_style> terminal_prices,
    py::list py_legs,
    double net_premium,
    bool has_underlying,
    double spot
) {
    auto tp = terminal_prices.unchecked<1>();
    int n   = tp.shape(0);

    std::vector<LegDef> legs;
    for (auto item : py_legs) {
        auto d = item.cast<py::dict>();
        LegDef leg;
        leg.strike      = d["strike"].cast<double>();
        leg.option_type  = (d["option_type"].cast<std::string>() == "C") ? 0 : 1;
        leg.direction    = d["direction"].cast<int>();
        leg.ratio        = d["ratio"].cast<int>();
        legs.push_back(leg);
    }

    // Compute PnL
    std::vector<double> pnl(n);
    for (int i = 0; i < n; ++i) {
        double s = tp(i);
        double payoff = 0.0;
        for (const auto& leg : legs) {
            double intr = (leg.option_type == 0)
                ? std::max(s - leg.strike, 0.0)
                : std::max(leg.strike - s, 0.0);
            payoff += leg.direction * leg.ratio * intr;
        }
        pnl[i] = payoff - net_premium;
        if (has_underlying) {
            pnl[i] += (s - spot);
        }
    }

    // Statistics
    double sum = 0.0;
    int loss_count = 0;
    double min_pnl = pnl[0];
    for (int i = 0; i < n; ++i) {
        sum += pnl[i];
        if (pnl[i] < 0.0) ++loss_count;
        if (pnl[i] < min_pnl) min_pnl = pnl[i];
    }
    double ev = sum / n;
    double prob_loss = (double)loss_count / n;
    double max_loss = std::max(0.0, -min_pnl);

    // Variance, skewness, kurtosis
    double var_sum = 0.0;
    for (int i = 0; i < n; ++i) {
        double d = pnl[i] - ev;
        var_sum += d * d;
    }
    double std_dev = std::sqrt(var_sum / n);

    double skew = 0.0, kurt = 0.0;
    if (std_dev > 1e-12) {
        double skew_sum = 0.0, kurt_sum = 0.0;
        for (int i = 0; i < n; ++i) {
            double z = (pnl[i] - ev) / std_dev;
            double z2 = z * z;
            skew_sum += z2 * z;
            kurt_sum += z2 * z2;
        }
        skew = skew_sum / n;
        kurt = kurt_sum / n;
    }

    // Sort for percentiles
    std::vector<double> sorted_pnl(pnl);
    std::sort(sorted_pnl.begin(), sorted_pnl.end());

    auto percentile = [&](double q) -> double {
        double idx = q * (n - 1);
        int lo = (int)idx;
        int hi = std::min(lo + 1, n - 1);
        double frac = idx - lo;
        return sorted_pnl[lo] * (1.0 - frac) + sorted_pnl[hi] * frac;
    };

    double p5  = percentile(0.05);
    double p1  = percentile(0.01);
    double var95 = std::max(0.0, -p5);
    double var99 = std::max(0.0, -p1);

    // Expected shortfall (mean of tail below 1st percentile)
    double tail_sum = 0.0;
    int tail_count = 0;
    for (int i = 0; i < n; ++i) {
        if (pnl[i] <= p1) {
            tail_sum += pnl[i];
            ++tail_count;
        }
    }
    double es = (tail_count > 0) ? std::max(0.0, -(tail_sum / tail_count)) : var99;

    // Convexity (mean abs second derivative of sorted pnl)
    double conv_sum = 0.0;
    for (int i = 1; i < n - 1; ++i) {
        double d2 = sorted_pnl[i + 1] - 2.0 * sorted_pnl[i] + sorted_pnl[i - 1];
        conv_sum += std::abs(d2);
    }
    double convexity = (n > 2) ? conv_sum / (n - 2) : 0.0;

    // Break-evens
    std::vector<double> be_levels;
    {
        // Sort by terminal price
        std::vector<int> order(n);
        std::iota(order.begin(), order.end(), 0);
        std::sort(order.begin(), order.end(), [&](int a, int b) {
            return tp(a) < tp(b);
        });
        for (int i = 0; i < n - 1; ++i) {
            int a = order[i], b = order[i + 1];
            if (pnl[a] * pnl[b] < 0.0) {
                double p0 = tp(a), p1val = tp(b);
                double v0 = pnl[a], v1 = pnl[b];
                double be = p0 + (p1val - p0) * (-v0) / (v1 - v0 + 1e-15);
                if (be_levels.empty() || std::abs(be - be_levels.back()) > std::max(spot * 0.005, 10.0)) {
                    be_levels.push_back(be);
                    if (be_levels.size() >= 6) break;
                }
            }
        }
    }

    // Build PnL ndarray
    auto pnl_arr = py::array_t<double>({(py::ssize_t)n});
    std::memcpy(pnl_arr.mutable_data(), pnl.data(), sizeof(double) * n);

    py::dict result;
    result["pnl"]             = pnl_arr;
    result["expected_value"]  = ev;
    result["var_95"]          = var95;
    result["var_99"]          = var99;
    result["expected_shortfall"] = es;
    result["probability_of_loss"] = prob_loss;
    result["max_loss"]        = max_loss;
    result["pnl_skewness"]   = skew;
    result["pnl_kurtosis"]   = kurt;
    result["convexity"]       = convexity;

    py::list be_list;
    for (double b : be_levels) be_list.append(b);
    result["break_even_levels"] = be_list;

    return result;
}


// ═══════════════════════════════════════════════════════════════════════
// 3.  BLACK-SCHOLES GREEKS  (vectorized over legs)
// ═══════════════════════════════════════════════════════════════════════

static double _norm_cdf(double x) {
    return 0.5 * std::erfc(-x * M_SQRT1_2);
}

static double _norm_pdf(double x) {
    return std::exp(-0.5 * x * x) / std::sqrt(2.0 * M_PI);
}

// Compute aggregate Greeks for a multi-leg strategy
static py::dict compute_greeks(
    py::list py_legs,
    double spot, double T, double r,
    py::dict iv_map   // { "strike_type" : sigma }  — or we accept a callback
) {
    double total_delta = 0.0, total_gamma = 0.0;
    double total_vega  = 0.0, total_theta = 0.0;

    double T_safe = std::max(T, 1e-8);
    double sqrt_T = std::sqrt(T_safe);

    for (auto item : py_legs) {
        auto d = item.cast<py::dict>();
        double strike   = d["strike"].cast<double>();
        std::string otype = d["option_type"].cast<std::string>();
        int direction   = d["direction"].cast<int>();
        int ratio       = d["ratio"].cast<int>();

        // Look up IV
        std::string key = std::to_string((int)strike) + "_" + otype;
        double sigma = 0.20; // default
        if (iv_map.contains(key)) {
            sigma = iv_map[key.c_str()].cast<double>();
        }
        sigma = std::max(sigma, 1e-8);

        double d1 = (std::log(spot / strike) + (r + 0.5 * sigma * sigma) * T_safe) / (sigma * sqrt_T);
        double d2 = d1 - sigma * sqrt_T;

        // Delta
        double delta = (otype == "C") ? _norm_cdf(d1) : (_norm_cdf(d1) - 1.0);
        // Gamma
        double gamma = _norm_pdf(d1) / (spot * sigma * sqrt_T);
        // Vega (per 1% vol move)
        double vega = spot * _norm_pdf(d1) * sqrt_T * 0.01;
        // Theta (per day)
        double theta_val;
        double term1 = -(spot * _norm_pdf(d1) * sigma) / (2.0 * sqrt_T);
        if (otype == "C") {
            theta_val = (term1 - r * strike * std::exp(-r * T_safe) * _norm_cdf(d2)) / 365.0;
        } else {
            theta_val = (term1 + r * strike * std::exp(-r * T_safe) * _norm_cdf(-d2)) / 365.0;
        }

        total_delta += direction * ratio * delta;
        total_gamma += direction * ratio * gamma;
        total_vega  += direction * ratio * vega;
        total_theta += direction * ratio * theta_val;
    }

    double skew = -0.25 * total_delta;

    py::dict result;
    result["delta"] = total_delta;
    result["gamma"] = total_gamma;
    result["vega"]  = total_vega;
    result["theta"] = total_theta;
    result["skew"]  = skew;
    return result;
}

// Compute net premium from BS pricing
static double compute_net_premium(
    py::list py_legs,
    double spot, double T, double r,
    py::dict iv_map
) {
    double total = 0.0;
    double T_safe = std::max(T, 1e-8);
    double sqrt_T = std::sqrt(T_safe);

    for (auto item : py_legs) {
        auto d = item.cast<py::dict>();
        double strike   = d["strike"].cast<double>();
        std::string otype = d["option_type"].cast<std::string>();
        int direction   = d["direction"].cast<int>();
        int ratio       = d["ratio"].cast<int>();

        std::string key = std::to_string((int)strike) + "_" + otype;
        double sigma = 0.20;
        if (iv_map.contains(key)) {
            sigma = iv_map[key.c_str()].cast<double>();
        }
        sigma = std::max(sigma, 1e-8);

        double d1 = (std::log(spot / strike) + (r + 0.5 * sigma * sigma) * T_safe) / (sigma * sqrt_T);
        double d2 = d1 - sigma * sqrt_T;

        double price;
        if (otype == "C") {
            price = spot * _norm_cdf(d1) - strike * std::exp(-r * T_safe) * _norm_cdf(d2);
        } else {
            double call = spot * _norm_cdf(d1) - strike * std::exp(-r * T_safe) * _norm_cdf(d2);
            price = call - spot + strike * std::exp(-r * T_safe);
        }
        total += direction * ratio * price;
    }
    return total;
}


// ═══════════════════════════════════════════════════════════════════════
// 4.  DYNAMIC HEDGING (vectorized Euler step)
// ═══════════════════════════════════════════════════════════════════════

static py::dict dynamic_hedge(
    py::array_t<double, py::array::c_style> full_price_paths,  // (steps+1, paths)
    double strike,
    double premium,
    int hedge_mode,        // 0=none, 1=daily_delta, 2=threshold
    double txn_cost_rate,
    double delta_threshold
) {
    auto buf = full_price_paths.unchecked<2>();
    int steps_plus_one = (int)buf.shape(0);
    int path_count     = (int)buf.shape(1);
    int steps          = steps_plus_one - 1;

    std::vector<double> hedge_pos(path_count, 0.0);
    std::vector<double> cum_cost(path_count, 0.0);
    std::vector<double> adj_count(path_count, 0.0);

    for (int t = 0; t < steps; ++t) {
        for (int i = 0; i < path_count; ++i) {
            double s     = buf(t, i);
            double s_next = buf(t + 1, i);
            double target_delta = std::min(std::max((s - strike) / std::max(std::abs(s), 1e-8), -1.0), 1.0);

            double adjustment = 0.0;
            if (hedge_mode == 1) {
                adjustment = target_delta - hedge_pos[i];
            } else if (hedge_mode == 2) {
                double gap = std::abs(target_delta - hedge_pos[i]);
                if (gap >= delta_threshold) {
                    adjustment = target_delta - hedge_pos[i];
                }
            }

            double trade_cost = txn_cost_rate * std::abs(adjustment) * s;
            hedge_pos[i] += adjustment;
            cum_cost[i]  += trade_cost;
            if (std::abs(adjustment) > 0.0) adj_count[i] += 1.0;

            double hedge_pnl = hedge_pos[i] * (s_next - s);
            cum_cost[i] -= hedge_pnl;
        }
    }

    // Terminal PnL
    auto pnl_arr = py::array_t<double>({(py::ssize_t)path_count});
    double* pnl_ptr = pnl_arr.mutable_data();
    double total_adj = 0.0;

    for (int i = 0; i < path_count; ++i) {
        double terminal = buf(steps, i);
        double payoff = std::max(terminal - strike, 0.0);
        pnl_ptr[i] = premium - payoff - cum_cost[i];
        total_adj += adj_count[i];
    }

    py::dict result;
    result["pnl"] = pnl_arr;
    result["average_adjustments"] = total_adj / path_count;
    return result;
}


// ═══════════════════════════════════════════════════════════════════════
// 5.  HESTON CHARACTERISTIC FUNCTION + FFT PRICING
// ═══════════════════════════════════════════════════════════════════════

static py::array_t<double> heston_fft_prices(
    double spot, double maturity, double rate, double div_yield,
    double kappa, double theta, double xi, double rho, double v0,
    py::array_t<double, py::array::c_style> strikes,
    int fft_n, double eta, double alpha
) {
    using cd = std::complex<double>;
    const cd I(0.0, 1.0);

    auto str_buf = strikes.unchecked<1>();
    int n_strikes = (int)str_buf.shape(0);

    double delta_k = 2.0 * M_PI / (fft_n * eta);
    double b       = 0.5 * fft_n * delta_k;
    double log_spot = std::log(std::max(spot, 1e-12));

    // Build FFT input
    std::vector<cd> fft_input(fft_n);
    std::vector<double> log_strike_grid(fft_n);
    std::vector<double> vj(fft_n);

    for (int j = 0; j < fft_n; ++j) {
        vj[j] = eta * j;
        log_strike_grid[j] = (log_spot - b) + delta_k * j;
    }

    // Simpson weights
    std::vector<double> weights(fft_n, 1.0);
    weights[0] = 1.0;
    for (int j = 1; j < fft_n; ++j) {
        weights[j] = (j % 2 == 1) ? 4.0 : 2.0;
    }
    if (fft_n > 1) weights[fft_n - 1] = 1.0;
    for (int j = 0; j < fft_n; ++j) weights[j] /= 3.0;

    // Characteristic function evaluation + build FFT input
    for (int j = 0; j < fft_n; ++j) {
        cd u = vj[j] - (alpha + 1.0) * I;

        cd rho_xi_iu = rho * xi * I * u;
        cd d = std::sqrt((rho_xi_iu - kappa) * (rho_xi_iu - kappa)
                         + xi * xi * (I * u + u * u));
        cd g = (kappa - rho_xi_iu - d) / (kappa - rho_xi_iu + d);

        cd exp_dt = std::exp(-d * maturity);
        cd c = (rate - div_yield) * I * u * maturity
             + (kappa * theta / (xi * xi))
               * ((kappa - rho_xi_iu - d) * maturity
                  - 2.0 * std::log((1.0 - g * exp_dt) / (1.0 - g)));
        cd d_term = ((kappa - rho_xi_iu - d) / (xi * xi))
                    * ((1.0 - exp_dt) / (1.0 - g * exp_dt));

        cd phi = std::exp(c + d_term * v0 + I * u * log_spot);

        cd denom = alpha * alpha + alpha - vj[j] * vj[j]
                   + I * (2.0 * alpha + 1.0) * vj[j];
        cd psi = std::exp(-rate * maturity) * phi / denom;

        fft_input[j] = std::exp(I * (b - log_spot) * vj[j]) * psi * eta * weights[j];
    }

    // In-place Cooley-Tukey FFT (radix-2)
    // Pad to power-of-2 if needed (fft_n should already be power of 2)
    int N = fft_n;
    // Bit-reversal permutation
    for (int i = 1, j2 = 0; i < N; ++i) {
        int bit = N >> 1;
        for (; j2 & bit; bit >>= 1) j2 ^= bit;
        j2 ^= bit;
        if (i < j2) std::swap(fft_input[i], fft_input[j2]);
    }
    // Butterfly
    for (int len = 2; len <= N; len <<= 1) {
        double ang = 2.0 * M_PI / len;
        cd wlen(std::cos(ang), std::sin(ang));
        for (int i = 0; i < N; i += len) {
            cd w(1.0, 0.0);
            for (int jj = 0; jj < len / 2; ++jj) {
                cd u_val = fft_input[i + jj];
                cd t = w * fft_input[i + jj + len / 2];
                fft_input[i + jj]           = u_val + t;
                fft_input[i + jj + len / 2] = u_val - t;
                w *= wlen;
            }
        }
    }

    // Extract call prices on grid
    std::vector<double> grid_strikes(fft_n);
    std::vector<double> call_grid(fft_n);
    int valid_count = 0;

    for (int j = 0; j < fft_n; ++j) {
        double gs = std::exp(log_strike_grid[j]);
        double cp = std::exp(-alpha * log_strike_grid[j]) * fft_input[j].real() / M_PI;
        if (std::isfinite(gs) && std::isfinite(cp)) {
            grid_strikes[valid_count] = gs;
            call_grid[valid_count]    = std::max(cp, 0.0);
            ++valid_count;
        }
    }

    if (valid_count < 2) {
        // Fallback: return zeros
        auto result = py::array_t<double>({(py::ssize_t)n_strikes});
        std::memset(result.mutable_data(), 0, sizeof(double) * n_strikes);
        return result;
    }

    // Enforce monotonicity (cummax from right)
    for (int i = valid_count - 2; i >= 0; --i) {
        call_grid[i] = std::max(call_grid[i], call_grid[i + 1]);
    }

    // Interpolate to target strikes (log-space linear interp)
    std::vector<double> log_grid(valid_count);
    for (int i = 0; i < valid_count; ++i) {
        log_grid[i] = std::log(std::max(grid_strikes[i], 1e-12));
    }

    auto result = py::array_t<double>({(py::ssize_t)n_strikes});
    double* out = result.mutable_data();

    for (int k = 0; k < n_strikes; ++k) {
        double log_target = std::log(std::max(str_buf(k), 1e-12));

        // Binary search
        if (log_target <= log_grid[0]) {
            out[k] = call_grid[0];
        } else if (log_target >= log_grid[valid_count - 1]) {
            out[k] = call_grid[valid_count - 1];
        } else {
            int lo = 0, hi = valid_count - 1;
            while (hi - lo > 1) {
                int mid = (lo + hi) / 2;
                if (log_grid[mid] <= log_target) lo = mid;
                else hi = mid;
            }
            double frac = (log_target - log_grid[lo]) / (log_grid[hi] - log_grid[lo] + 1e-30);
            out[k] = call_grid[lo] + frac * (call_grid[hi] - call_grid[lo]);
        }
        out[k] = std::max(out[k], 0.0);
    }
    return result;
}


// ═══════════════════════════════════════════════════════════════════════
// 6.  IMPLIED VOL FROM CALL PRICES (Brent root-finding)
// ═══════════════════════════════════════════════════════════════════════

static double _bs_call(double s, double k, double T, double r, double q, double sig) {
    sig = std::max(sig, 1e-12);
    T   = std::max(T, 1e-12);
    double sqrt_T = std::sqrt(T);
    double d1 = (std::log(s / k) + (r - q + 0.5 * sig * sig) * T) / (sig * sqrt_T);
    double d2 = d1 - sig * sqrt_T;
    return s * std::exp(-q * T) * _norm_cdf(d1) - k * std::exp(-r * T) * _norm_cdf(d2);
}

static double _brent_iv(double target, double s, double k, double T, double r, double q,
                         double lo, double hi, int maxiter) {
    double f_lo = _bs_call(s, k, T, r, q, lo) - target;
    double f_hi = _bs_call(s, k, T, r, q, hi) - target;

    if (f_lo * f_hi > 0.0) {
        // No bracket — return fallback
        double fallback = std::sqrt(std::max(2.0 * std::log(std::max(s, 1e-12) / k), 0.0) / T);
        return std::min(std::max(fallback, lo), hi);
    }

    double a = lo, b = hi, fa = f_lo, fb = f_hi;
    double c = a, fc = fa;
    bool mflag = true;
    double d_val = 0.0;

    for (int i = 0; i < maxiter; ++i) {
        if (std::abs(fb) < 1e-12) return b;
        if (std::abs(fa) < 1e-12) return a;
        if (std::abs(b - a) < 1e-10) return b;

        double s_val;
        if (std::abs(fa - fc) > 1e-15 && std::abs(fb - fc) > 1e-15) {
            // Inverse quadratic
            s_val = a * fb * fc / ((fa - fb) * (fa - fc))
                  + b * fa * fc / ((fb - fa) * (fb - fc))
                  + c * fa * fb / ((fc - fa) * (fc - fb));
        } else {
            s_val = b - fb * (b - a) / (fb - fa);
        }

        double cond1 = (3.0 * a + b) / 4.0;
        double cond2 = b;
        if (cond1 > cond2) std::swap(cond1, cond2);

        bool reject = false;
        if (s_val < cond1 || s_val > cond2) reject = true;
        else if (mflag && std::abs(s_val - b) >= std::abs(b - c) * 0.5) reject = true;
        else if (!mflag && std::abs(s_val - b) >= std::abs(c - d_val) * 0.5) reject = true;

        if (reject) {
            s_val = (a + b) * 0.5;
            mflag = true;
        } else {
            mflag = false;
        }

        double fs = _bs_call(s, k, T, r, q, s_val) - target;
        d_val = c;
        c = b; fc = fb;

        if (fa * fs < 0.0) { b = s_val; fb = fs; }
        else { a = s_val; fa = fs; }

        if (std::abs(fa) < std::abs(fb)) {
            std::swap(a, b);
            std::swap(fa, fb);
        }
    }
    return b;
}

static py::array_t<double> implied_vols_from_calls(
    py::array_t<double, py::array::c_style> call_prices,
    double spot,
    py::array_t<double, py::array::c_style> strikes,
    double maturity, double rate, double div_yield
) {
    auto cp = call_prices.unchecked<1>();
    auto sk = strikes.unchecked<1>();
    int n = (int)cp.shape(0);

    auto result = py::array_t<double>({(py::ssize_t)n});
    double* out = result.mutable_data();

    double disc_spot = spot * std::exp(-div_yield * maturity);

    for (int i = 0; i < n; ++i) {
        double k = std::max(sk(i), 1e-12);
        double intrinsic = std::max(disc_spot - k * std::exp(-rate * maturity), 0.0);
        double upper = std::max(disc_spot - 1e-12, intrinsic + 1e-12);
        double target = std::min(std::max(cp(i), intrinsic + 1e-12), upper);
        out[i] = _brent_iv(target, spot, k, maturity, rate, div_yield, 1e-6, 5.0, 200);
    }
    return result;
}


// ═══════════════════════════════════════════════════════════════════════
// 7.  BATCH STRATEGY EVALUATOR  (evaluate N strategies in one C++ call)
// ═══════════════════════════════════════════════════════════════════════

// Helper: evaluate a single strategy (used by batch)
struct StrategyInput {
    std::vector<LegDef> legs;
    double net_premium;
    bool has_underlying;
    double margin;
};

struct StrategyResult {
    std::vector<double> pnl;
    double ev, var95, var99, es, prob_loss, max_loss;
    double skew, kurt, convexity, rom;
};

static StrategyResult eval_one_strategy(
    const double* tp, int n, const StrategyInput& si, double spot
) {
    StrategyResult r;
    r.pnl.resize(n);

    for (int i = 0; i < n; ++i) {
        double s = tp[i];
        double payoff = 0.0;
        for (const auto& leg : si.legs) {
            double intr = (leg.option_type == 0)
                ? std::max(s - leg.strike, 0.0)
                : std::max(leg.strike - s, 0.0);
            payoff += leg.direction * leg.ratio * intr;
        }
        r.pnl[i] = payoff - si.net_premium;
        if (si.has_underlying) r.pnl[i] += (s - spot);
    }

    double sum = 0.0;
    int loss_count = 0;
    double min_pnl = r.pnl[0];
    for (int i = 0; i < n; ++i) {
        sum += r.pnl[i];
        if (r.pnl[i] < 0.0) ++loss_count;
        if (r.pnl[i] < min_pnl) min_pnl = r.pnl[i];
    }
    r.ev = sum / n;
    r.prob_loss = (double)loss_count / n;
    r.max_loss = std::max(0.0, -min_pnl);

    double var_sum = 0.0;
    for (int i = 0; i < n; ++i) {
        double d = r.pnl[i] - r.ev;
        var_sum += d * d;
    }
    double std_dev = std::sqrt(var_sum / n);

    r.skew = 0.0; r.kurt = 0.0;
    if (std_dev > 1e-12) {
        double skew_sum = 0.0, kurt_sum = 0.0;
        for (int i = 0; i < n; ++i) {
            double z = (r.pnl[i] - r.ev) / std_dev;
            double z2 = z * z;
            skew_sum += z2 * z;
            kurt_sum += z2 * z2;
        }
        r.skew = skew_sum / n;
        r.kurt = kurt_sum / n;
    }

    // Use partial sort for percentiles (much faster than full sort for large n)
    // We need the 1st and 5th percentile
    std::vector<double> sorted_pnl(r.pnl);
    std::sort(sorted_pnl.begin(), sorted_pnl.end());
    auto pctl = [&](double q) -> double {
        double idx = q * (n - 1);
        int lo = (int)idx;
        int hi = std::min(lo + 1, n - 1);
        double frac = idx - lo;
        return sorted_pnl[lo] * (1.0 - frac) + sorted_pnl[hi] * frac;
    };
    r.var95 = std::max(0.0, -pctl(0.05));
    r.var99 = std::max(0.0, -pctl(0.01));
    double p1 = pctl(0.01);
    double tail_sum = 0.0; int tail_count = 0;
    for (int i = 0; i < n; ++i) {
        if (r.pnl[i] <= p1) { tail_sum += r.pnl[i]; ++tail_count; }
    }
    r.es = (tail_count > 0) ? std::max(0.0, -(tail_sum / tail_count)) : r.var99;

    r.convexity = 0.0;
    for (int i = 1; i < n - 1; ++i) {
        double d2 = sorted_pnl[i+1] - 2.0*sorted_pnl[i] + sorted_pnl[i-1];
        r.convexity += std::abs(d2);
    }
    r.convexity = (n > 2) ? r.convexity / (n - 2) : 0.0;

    double cost = (si.net_premium > 0) ? std::abs(si.net_premium) : std::max(si.margin, std::abs(si.net_premium) + 1.0);
    r.rom = r.ev / std::max(cost, 1e-8);

    return r;
}

// Evaluate multiple strategies against the same terminal prices
// Multi-threaded: strategies are distributed across hardware threads
static py::list batch_evaluate_strategies(
    py::array_t<double, py::array::c_style> terminal_prices,
    py::list strategy_list,   // list of dicts: {legs, net_premium, has_underlying, spot, margin}
    double spot
) {
    auto tp = terminal_prices.unchecked<1>();
    int n = (int)tp.shape(0);
    const double* tp_ptr = tp.data(0);

    // Parse all strategies from Python (must be done under GIL)
    int ns = (int)py::len(strategy_list);
    std::vector<StrategyInput> inputs(ns);
    for (int si_idx = 0; si_idx < ns; ++si_idx) {
        auto sd = strategy_list[si_idx].cast<py::dict>();
        auto py_legs = sd["legs"].cast<py::list>();
        inputs[si_idx].net_premium    = sd["net_premium"].cast<double>();
        inputs[si_idx].has_underlying = sd["has_underlying"].cast<bool>();
        inputs[si_idx].margin         = sd["margin"].cast<double>();
        for (auto leg_item : py_legs) {
            auto ld = leg_item.cast<py::dict>();
            LegDef leg;
            leg.strike      = ld["strike"].cast<double>();
            leg.option_type  = (ld["option_type"].cast<std::string>() == "C") ? 0 : 1;
            leg.direction    = ld["direction"].cast<int>();
            leg.ratio        = ld["ratio"].cast<int>();
            inputs[si_idx].legs.push_back(leg);
        }
    }

    // Evaluate all strategies in parallel (release GIL)
    std::vector<StrategyResult> all_results(ns);
    {
        py::gil_scoped_release release;
        int n_threads = std::min((int)std::thread::hardware_concurrency(), std::max(1, ns));
        if (n_threads > 16) n_threads = 16;
        std::vector<std::thread> threads(n_threads);

        auto worker = [&](int tid) {
            for (int i = tid; i < ns; i += n_threads) {
                all_results[i] = eval_one_strategy(tp_ptr, n, inputs[i], spot);
            }
        };
        for (int t = 0; t < n_threads; ++t)
            threads[t] = std::thread(worker, t);
        for (int t = 0; t < n_threads; ++t)
            threads[t].join();
    }

    // Convert results to Python dicts (under GIL)
    py::list results;
    for (int i = 0; i < ns; ++i) {
        const auto& r = all_results[i];
        auto pnl_arr = py::array_t<double>({(py::ssize_t)n});
        std::memcpy(pnl_arr.mutable_data(), r.pnl.data(), sizeof(double) * n);

        py::dict rd;
        rd["pnl"]               = pnl_arr;
        rd["expected_value"]     = r.ev;
        rd["var_95"]             = r.var95;
        rd["var_99"]             = r.var99;
        rd["expected_shortfall"] = r.es;
        rd["probability_of_loss"] = r.prob_loss;
        rd["max_loss"]           = r.max_loss;
        rd["pnl_skewness"]      = r.skew;
        rd["pnl_kurtosis"]      = r.kurt;
        rd["convexity"]          = r.convexity;
        rd["return_on_margin"]   = r.rom;

        results.append(rd);
    }

    return results;
}


// ═══════════════════════════════════════════════════════════════════════
//  PYBIND11 MODULE
// ═══════════════════════════════════════════════════════════════════════

PYBIND11_MODULE(vol_core, m) {
    m.doc() = "High-performance C++ core for Heston MC, BS Greeks, payoff evaluation, and FFT pricing";

    m.def("heston_mc", &heston_mc,
        py::arg("kappa"), py::arg("theta"), py::arg("xi"), py::arg("rho"), py::arg("v0"),
        py::arg("spot"), py::arg("maturity"), py::arg("rate"),
        py::arg("paths"), py::arg("steps"), py::arg("seed"), py::arg("full_path"),
        "Multi-threaded Heston Monte Carlo simulation. Returns (terminal, price_paths, vol_paths).");

    m.def("intrinsic_payoff", &intrinsic_payoff,
        py::arg("terminal_prices"), py::arg("legs"),
        "Vectorized multi-leg intrinsic payoff.");

    m.def("evaluate_strategy", &evaluate_strategy,
        py::arg("terminal_prices"), py::arg("legs"),
        py::arg("net_premium"), py::arg("has_underlying"), py::arg("spot"),
        "Full strategy evaluation: PnL, VaR, ES, stats.");

    m.def("compute_greeks", &compute_greeks,
        py::arg("legs"), py::arg("spot"), py::arg("T"), py::arg("r"), py::arg("iv_map"),
        "Aggregate BS Greeks for multi-leg strategy.");

    m.def("compute_net_premium", &compute_net_premium,
        py::arg("legs"), py::arg("spot"), py::arg("T"), py::arg("r"), py::arg("iv_map"),
        "Net premium from BS pricing.");

    m.def("dynamic_hedge", &dynamic_hedge,
        py::arg("full_price_paths"), py::arg("strike"), py::arg("premium"),
        py::arg("hedge_mode"), py::arg("txn_cost_rate"), py::arg("delta_threshold"),
        "Dynamic hedging simulation. hedge_mode: 0=none, 1=daily_delta, 2=threshold.");

    m.def("heston_fft_prices", &heston_fft_prices,
        py::arg("spot"), py::arg("maturity"), py::arg("rate"), py::arg("div_yield"),
        py::arg("kappa"), py::arg("theta"), py::arg("xi"), py::arg("rho"), py::arg("v0"),
        py::arg("strikes"), py::arg("fft_n"), py::arg("eta"), py::arg("alpha"),
        "Heston FFT call pricing with built-in Cooley-Tukey FFT.");

    m.def("implied_vols_from_calls", &implied_vols_from_calls,
        py::arg("call_prices"), py::arg("spot"), py::arg("strikes"),
        py::arg("maturity"), py::arg("rate"), py::arg("div_yield"),
        "Implied vol extraction via Brent root-finding.");

    m.def("batch_evaluate_strategies", &batch_evaluate_strategies,
        py::arg("terminal_prices"), py::arg("strategy_list"), py::arg("spot"),
        "Evaluate multiple strategies in a single C++ call.");
}
