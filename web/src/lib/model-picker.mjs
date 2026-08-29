/**
 * Model-picker resolution for the config page.
 *
 * The saved model must survive page loads even when the freshly-fetched option
 * list doesn't include it (opencode's list is dynamic — `opencode models` /
 * config files — and can diverge from what the user actually runs). The saved
 * model is only dropped when the user has explicitly switched to a different
 * CLI than the one the model was saved under; then the new CLI's own default
 * applies instead of passing it a model that CLI doesn't know.
 *
 * @param {object} args
 * @param {string} args.model - saved model id ("" = none chosen)
 * @param {string} args.modelCliId - CLI the model was saved under ("" = legacy
 *   config / unknown → treated as belonging to the currently selected CLI)
 * @param {string} args.cliId - currently selected CLI id
 * @param {{id: string, label: string}[]} [args.options] - the selected CLI's
 *   model dropdown options
 * @returns {{ model: string; options: {id: string, label: string}[] }}
 *   `model` is the id the picker should show ("" → fall back to the CLI
 *   default); `options` is the dropdown list, with the preserved model injected
 *   first when it wasn't already listed so it renders as the selected value.
 */
export function resolveModelPicker({ model, modelCliId, cliId, options = [] }) {
  if (!model) return { model: "", options };
  // Explicitly saved under a different CLI → the user switched CLI rows: drop
  // the pick so the new CLI falls back to its own default.
  if (modelCliId && modelCliId !== cliId) return { model: "", options };
  if (options.some((o) => o.id === model)) return { model, options };
  return { model, options: [{ id: model, label: model }, ...options] };
}
