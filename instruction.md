⸻

NIFTY STOCHASTIC VOLATILITY STRATEGY ENGINE

STRICT DEVELOPMENT PROTOCOL FOR LLM

⸻

1. GENERAL DEVELOPMENT RULES
	1.	This is a production-grade quantitative trading infrastructure project.
Do not generate toy examples, placeholder logic, or demonstration snippets.
	2.	Do not create any files unless explicitly requested.
	3.	Do not create random files such as:
	•	test.py
	•	example.py
	•	demo.py
	•	notes.md
	•	README.md
	•	documentation.md
	•	scratch notebooks
	•	temporary debug files
	4.	Do not create additional .md documentation files unless explicitly instructed.
	5.	Do not use emojis anywhere.
	6.	Do not assume missing requirements.
If any requirement is unclear, ask before implementing.
	7.	Do not generate mock data unless explicitly requested.
	8.	Do not introduce frameworks, libraries, or architectural changes without approval.
	9.	Every file must be minimal, clean, production-ready, and deterministic.
	10.	No experimental shortcuts. No pseudo-code.

⸻

2. CODE QUALITY REQUIREMENTS
	1.	Use proper Python OOP design.
	2.	One class = one responsibility.
	3.	One function = one clear purpose.
	4.	Keep functions small and focused.
	5.	Proper indentation.
Do not generate malformed indentation.
	6.	Minimal but sufficient comments.
Do not over-comment trivial lines.
	7.	Avoid unnecessary refactoring.
	8.	Avoid redundant abstractions.
	9.	Avoid magic numbers. Use configuration.
	10.	Type hints must be used consistently.

⸻

3. PROJECT STRUCTURE REQUIREMENTS

Strict modular structure must be followed.

Example structure:

backend/
    main.py
    config.py
    logger.py
    decorators.py

    data/
        ingestion.py
        repository.py
        models.py

    surface/
        builder.py
        liquidity_filter.py

    calibration/
        heston_fft.py
        objective.py
        joint_calibrator.py

    simulation/
        heston_mc.py
        dynamic_hedge.py

    strategy/
        base_strategy.py
        strategy_factory.py
        long_call.py
        iron_condor.py
        ...

    evaluation/
        static_evaluator.py
        ranking_engine.py
        fragility_engine.py

    regime/
        garch_model.py
        hmm_model.py
        regime_classifier.py

    backtest/
        walk_forward.py

Rules:
	•	Do not merge unrelated logic into one file.
	•	Do not create circular imports.
	•	Each module must be independently testable.

⸻

4. LOGGING REQUIREMENTS
	1.	Use Python logging module only.
	2.	No print() statements.
	3.	Centralized logging configuration in logger.py.
	4.	Log levels must include:
	•	DEBUG
	•	INFO
	•	WARNING
	•	ERROR
	5.	Each major function must log:
	•	Start
	•	End
	•	Key intermediate values (if relevant)
	•	Errors with context
	6.	Logs must be structured and informative.

⸻

5. EXECUTION TIME DECORATOR
	1.	Create a reusable decorator in decorators.py.
	2.	The decorator must:
	•	Measure execution time of each function
	•	Log time taken using logger
	•	Preserve function metadata
	3.	Every computationally heavy function must use this decorator.
	4.	Do not duplicate timing logic across files.

⸻

6. STRICT OOP GUIDELINES
	1.	Use abstract base classes where appropriate.
	2.	Use inheritance only when logically required.
	3.	Avoid deep inheritance chains.
	4.	Prefer composition over inheritance.
	5.	Use dataclasses for structured data objects.
	6.	Avoid global variables.
	7.	All configuration must come from config.py.

⸻

7. BACKEND API RULES
	1.	Use FastAPI.
	2.	Separate:
	•	API layer
	•	Service layer
	•	Quant engine layer
	3.	No quant logic inside API routes.
	4.	API routes should only:
	•	Validate input
	•	Call service layer
	•	Return structured response

⸻

8. CALIBRATION ENGINE RULES
	1.	Must implement joint Heston calibration.
	2.	Must use Carr–Madan FFT pricing.
	3.	Must support multi-expiry calibration simultaneously.
	4.	Calibration objective must be liquidity-weighted RMSE.
	5.	Must log:
	•	Parameter convergence
	•	Iterations
	•	Final error
	6.	If calibration fails, system must raise structured error.

⸻

9. MONTE CARLO ENGINE RULES
	1.	Vectorized implementation.
	2.	Use Numba if required.
	3.	No nested Python loops over paths.
	4.	Allow configurable:
	•	Path count
	•	Time steps
	•	Random seed
	5.	Support:
	•	Terminal-only simulation
	•	Full path simulation

⸻

10. STRATEGY ENGINE RULES
	1.	Each strategy must be its own class.
	2.	Use a base abstract strategy class.
	3.	StrategyFactory must dynamically construct strategies.
	4.	Strike filtering logic must respect:
	•	Liquidity constraints
	•	Strike increment rules
	•	Moneyness window
	5.	No hardcoded strike combinations.

⸻

11. DYNAMIC HEDGING RULES
	1.	Must support:
	•	No hedge
	•	Daily delta hedge
	•	Threshold hedge
	2.	Must include transaction cost modeling.
	3.	Must log hedge adjustments.
	4.	Must be optional due to compute cost.

⸻

12. RANKING ENGINE RULES
	1.	Scoring function must be configurable.
	2.	Regime dependent weights must be configurable.
	3.	Must avoid overfitting bias.
	4.	Must allow out-of-sample evaluation.

⸻

13. ERROR HANDLING RULES
	1.	No silent failures.
	2.	Raise structured exceptions.
	3.	Log all exceptions.
	4.	API must return meaningful error responses.

⸻

14. PERFORMANCE RULES
	1.	Avoid recomputing FFT pricing unnecessarily.
	2.	Cache reusable computations.
	3.	Avoid redundant recalibration.
	4.	Parallelize only when necessary.
	5.	Do not prematurely optimize.

⸻

15. DEVELOPMENT DISCIPLINE
	1.	Do not generate speculative code.
	2.	Do not guess missing business logic.
	3.	Ask for clarification if needed.
	4.	Write clean, final-form code.
	5.	Avoid repeated refactoring cycles.

⸻

16. ADDITIONAL SUGGESTIONS
	1.	Implement calibration stability monitoring across time.
	2.	Store parameter history for regime insight.
	3.	Add calibration confidence score.
	4.	Include deterministic random seed control.
	5.	Build walk-forward validation early.
	6.	Add unit tests only when explicitly requested.
	7.	Keep production discipline from day one.

⸻

END OF FILE