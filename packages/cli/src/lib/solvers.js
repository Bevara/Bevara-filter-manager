import { splitModule } from './manifest.js';

// The solvers the player ships, as pages name them (<name>_<version>): the
// multimedia solver, and its minimal build for <img> and <audio>.
export const SOLVER = 'mm_solver_1.0.7';
export const SOLVER_MINIMAL = 'mm_solver_minimal_1.0.1';
// Most capable for the fewest bytes first.
export const KNOWN_SOLVERS = [SOLVER_MINIMAL, SOLVER];
// The player directory a solver is built in (Editor/Interface/player/solver_minimal).
export const solverDir = (module) => (splitModule(module)?.base ?? String(module)).replace(/^mm_/, '');
