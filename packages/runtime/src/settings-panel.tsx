import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Settings2, X } from 'lucide-react';
import { NappletConfig } from './config-session';
import { resolveConfig, type ConfigSchema, type ConfigValues } from './config-schema';

const styles = `
.nap-settings-trigger{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--border, #d1d3c4);background:transparent;color:inherit;border-radius:7px;padding:8px 10px;font:inherit;cursor:pointer}
.nap-settings-trigger:disabled{opacity:.45;cursor:default}.nap-settings-trigger[data-icon=true]{border:0;padding:8px}
.nap-settings-overlay{position:fixed;inset:0;background:#20271bc0;z-index:120}
.nap-settings-dialog{position:fixed;z-index:121;left:50%;top:50%;transform:translate(-50%,-50%);width:min(540px,calc(100vw - 32px));max-height:calc(100dvh - 40px);overflow:auto;background:var(--background, #f8f6ed);color:var(--foreground, #292d23);border:1px solid var(--border, #d1d3c4);border-radius:16px;box-shadow:0 24px 80px #0005;padding:28px;box-sizing:border-box;font:14px 'DM Sans',system-ui,sans-serif}
.nap-settings-dialog *{box-sizing:border-box}.nap-settings-dialog h2{margin:0 40px 8px 0;font-size:26px;line-height:1.15;letter-spacing:-.6px}.nap-settings-description{font-size:13px;color:var(--muted-foreground, #63705c);line-height:1.55;margin:0 0 20px}
.nap-settings-close{position:absolute;right:17px;top:17px;border:0;background:transparent;cursor:pointer;color:inherit;padding:5px}
.nap-settings-field{display:grid;gap:6px;margin:0 0 18px}.nap-settings-field label{font-weight:600}.nap-settings-field small{color:var(--muted-foreground, #65725e);line-height:1.4}.nap-settings-field input,.nap-settings-field select,.nap-settings-field textarea{width:100%;min-height:40px;padding:9px 11px;border:1px solid var(--border, #c8cbbf);border-radius:7px;background:var(--card, #fffdf5);color:var(--foreground, #292d23);font:inherit}.nap-settings-field textarea{min-height:76px;font:12px monospace;resize:vertical}
.nap-settings-fields{border:0;padding:0;margin:0}.nap-settings-nested{padding:12px 14px 0;border:1px solid var(--border, #d1d3c4);border-radius:8px;margin:0 0 18px}.nap-settings-nested legend{padding:0 5px;font-weight:600}.nap-settings-section{font:11px 'DM Mono',monospace;text-transform:uppercase;letter-spacing:1px;color:var(--mint, #447b65);margin:22px 0 13px}
.nap-settings-actions{position:sticky;bottom:-28px;background:var(--background, #f8f6ed);display:flex;justify-content:flex-end;align-items:center;gap:9px;border-top:1px solid var(--border, #d1d3c4);padding:17px 0 0;margin-top:8px}.nap-settings-actions button{padding:9px 13px;border:1px solid var(--border, #c8cbbf);border-radius:7px;background:transparent;color:inherit;font:inherit;cursor:pointer}.nap-settings-actions .nap-settings-save{background:var(--primary, #303828);color:var(--primary-foreground, #fffdf5);border-color:var(--primary, #303828)}.nap-settings-reset{margin-right:auto}.nap-settings-error{color:var(--destructive, #a43e29);font-size:13px;line-height:1.4}.nap-settings-note{font-size:12px;color:var(--muted-foreground, #65725e);line-height:1.5}
.nap-settings-dialog :focus-visible,.nap-settings-trigger:focus-visible{outline:2px solid var(--mint, #397c65);outline-offset:3px}@media(max-width:480px){.nap-settings-dialog{padding:22px}.nap-settings-actions{bottom:-22px;flex-wrap:wrap}.nap-settings-reset{margin-right:0}}
`;
const ordered = (schema: ConfigSchema) =>
  Object.entries(schema.properties ?? {}).sort(
    ([a, x], [b, y]) =>
      (x['x-napplet-section'] ?? '').localeCompare(y['x-napplet-section'] ?? '') ||
      (x['x-napplet-order'] ?? Infinity) - (y['x-napplet-order'] ?? Infinity) ||
      a.localeCompare(b),
  );
function Fields({
  schema,
  values,
  path = [],
  id,
}: {
  schema: ConfigSchema;
  values: ConfigValues;
  path?: string[];
  id: string;
}) {
  let section = '';
  return (
    <>
      {ordered(schema).map(([key, field]) => {
        const parts = [...path, key],
          name = JSON.stringify(parts),
          fieldId = `${id}-${parts.map(encodeURIComponent).join('.')}`;
        const value = values[key],
          label = field.title || key,
          required = schema.required?.includes(key);
        const nextSection = field['x-napplet-section'] ?? '';
        const heading =
          nextSection && nextSection !== section ? (
            <h3 className="nap-settings-section" data-section={nextSection}>
              {nextSection}
            </h3>
          ) : null;
        section = nextSection;
        if (field.type === 'object')
          return (
            <div key={name}>
              {heading}
              <fieldset className="nap-settings-nested">
                <legend>{label}</legend>
                <Fields
                  schema={field}
                  values={(value as ConfigValues) ?? {}}
                  path={parts}
                  id={id}
                />
              </fieldset>
            </div>
          );
        return (
          <div key={name}>
            {heading}
            <div className="nap-settings-field">
              <label htmlFor={fieldId}>
                {label}
                {required ? ' *' : ''}
              </label>
              {(field.enum && !field['x-napplet-secret']) || field.type === 'boolean' ? (
                <select
                  id={fieldId}
                  name={name}
                  required={required}
                  defaultValue={value === undefined ? '' : JSON.stringify(value)}
                  aria-describedby={`${fieldId}-help`}
                >
                  <option value="">Not set</option>
                  {(field.enum ?? [true, false]).map((option, i) => (
                    <option key={i} value={JSON.stringify(option)}>
                      {field.enumDescriptions?.[i] ??
                        (typeof option === 'boolean'
                          ? option
                            ? 'On'
                            : 'Off'
                          : typeof option === 'object'
                            ? JSON.stringify(option)
                            : String(option))}
                    </option>
                  ))}
                </select>
              ) : field.type === 'array' ? (
                <textarea
                  id={fieldId}
                  name={name}
                  required={required}
                  defaultValue={value === undefined ? '' : JSON.stringify(value)}
                  aria-describedby={`${fieldId}-help`}
                />
              ) : (
                <input
                  id={fieldId}
                  name={name}
                  type={
                    field['x-napplet-secret']
                      ? 'password'
                      : ['number', 'integer'].includes(field.type)
                        ? 'number'
                        : 'text'
                  }
                  defaultValue={value === undefined ? '' : String(value)}
                  required={required}
                  min={field.minimum}
                  max={field.maximum}
                  step={field.type === 'integer' ? 1 : 'any'}
                  autoComplete="off"
                  aria-describedby={`${fieldId}-help`}
                />
              )}
              <small id={`${fieldId}-help`}>
                {field.description || field.markdownDescription}
                {field.type === 'array' ? ' Enter a JSON list.' : ''}
                {field['x-napplet-secret']
                  ? ' Shared with this napplet only after you save; kept for this session.'
                  : ''}
              </small>
              {field.deprecationMessage && <small>{field.deprecationMessage}</small>}
            </div>
          </div>
        );
      })}
    </>
  );
}
function formValues(schema: ConfigSchema, data: FormData, path: string[] = []): ConfigValues {
  const values: ConfigValues = {};
  for (const [key, field] of Object.entries(schema.properties ?? {})) {
    const parts = [...path, key];
    if (field.type === 'object') {
      const nested = formValues(field, data, parts);
      if (Object.keys(nested).length || schema.required?.includes(key)) values[key] = nested;
      continue;
    }
    const raw = String(data.get(JSON.stringify(parts)) ?? '');
    if (!raw && (field['x-napplet-secret'] || field.type !== 'string' || field.enum)) continue;
    values[key] =
      (field.enum && !field['x-napplet-secret']) || ['array', 'boolean'].includes(field.type)
        ? JSON.parse(raw)
        : ['number', 'integer'].includes(field.type)
          ? Number(raw)
          : raw;
  }
  return values;
}
/** Shared shadcn-style Radix dialog. Its portal remains inside the fullscreen host. */
export function SettingsControl({
  session,
  container,
  title,
  iconOnly = false,
  onOpenChange,
}: {
  session: NappletConfig;
  container?: HTMLElement | null;
  title: string;
  iconOnly?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const view = useSyncExternalStore(
    session.subscribeView,
    session.getSnapshot,
    session.getSnapshot,
  );
  const id = useId();
  const [reset, setReset] = useState(0),
    [parseError, setParseError] = useState('');
  const [resetValues, setResetValues] = useState<ConfigValues | null>(null);
  useEffect(() => {
    onOpenChange?.(view.open);
    return () => onOpenChange?.(false);
  }, [view.open, onOpenChange]);
  useEffect(() => {
    if (!view.open) {
      setParseError('');
      setResetValues(null);
    }
  }, [view.open]);
  return (
    <>
      <style>{styles}</style>
      <Dialog.Root
        open={view.open}
        onOpenChange={(open) => (open ? session.open() : session.dismiss())}
      >
        <Dialog.Trigger asChild>
          <button
            type="button"
            className="nap-settings-trigger"
            data-icon={iconOnly}
            aria-label="Napplet settings"
            disabled={!view.schema}
            title={
              view.schema
                ? 'Napplet settings'
                : view.error || 'This napplet has not declared settings.'
            }
          >
            <Settings2 size={16} />
            {!iconOnly && 'Settings'}
          </button>
        </Dialog.Trigger>
        <Dialog.Portal container={container ?? undefined}>
          <Dialog.Overlay className="nap-settings-overlay" />
          <Dialog.Content
            className="nap-settings-dialog"
            onOpenAutoFocus={() => {
              if (view.section)
                requestAnimationFrame(() => {
                  const section = [
                    ...(container ?? document).querySelectorAll<HTMLElement>('[data-section]'),
                  ].find((item) => item.dataset.section === view.section);
                  section?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
                });
            }}
          >
            <Dialog.Title>Make it feel like yours.</Dialog.Title>
            <Dialog.Description className="nap-settings-description">
              {title} · Settings for this build and account, on this browser.
            </Dialog.Description>
            <Dialog.Close className="nap-settings-close" aria-label="Close settings">
              <X size={20} />
            </Dialog.Close>
            {view.schema && (
              <form
                key={reset}
                onSubmit={(event) => {
                  event.preventDefault();
                  try {
                    setParseError('');
                    session.commit(formValues(view.schema!, new FormData(event.currentTarget)));
                  } catch {
                    setParseError('Enter valid JSON lists and choose values before saving.');
                  }
                }}
              >
                <fieldset className="nap-settings-fields">
                  <Fields schema={view.schema} values={resetValues ?? view.values} id={id} />
                </fieldset>
                {!view.persistent && (
                  <p className="nap-settings-note">
                    Browser storage is unavailable. These settings last for this session.
                  </p>
                )}
                {(view.error || parseError) && (
                  <p role="alert" className="nap-settings-error">
                    {parseError || view.error}
                  </p>
                )}
                <div className="nap-settings-actions">
                  <button
                    type="button"
                    className="nap-settings-reset"
                    onClick={() => {
                      setResetValues(resolveConfig(view.schema!, {}));
                      setReset((n) => n + 1);
                      setParseError('');
                    }}
                  >
                    Reset defaults
                  </button>
                  <Dialog.Close asChild>
                    <button type="button">Cancel</button>
                  </Dialog.Close>
                  <button type="submit" className="nap-settings-save">
                    Save settings
                  </button>
                </div>
              </form>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {!view.schema && view.error && (
        <span role="status" className="nap-settings-error">
          Settings unavailable: {view.error}
        </span>
      )}
    </>
  );
}
