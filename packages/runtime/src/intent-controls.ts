import { IntentWorkspace, type IntentAvailability, type IntentRequest } from './intent-session';

/** Host-owned dialog: selection and defaults never come from the napplet frame. */
export function chooseIntentHandler(
  availability: IntentAvailability,
  request: IntentRequest,
): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', 'Choose napplet handler');
    const title = document.createElement('h2');
    title.textContent = `Open ${request.archetype}`;
    const explanation = document.createElement('p');
    explanation.textContent = `Choose a napplet for ${request.action}.`;
    const controls = document.createElement('div');
    const finish = (id: string | null) => {
      dialog.close();
      dialog.remove();
      resolve(id);
    };
    for (const candidate of availability.candidates) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = candidate.title ?? candidate.id;
      button.onclick = () => finish(candidate.id);
      controls.append(button);
    }
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => finish(null);
    dialog.oncancel = (event) => {
      event.preventDefault();
      finish(null);
    };
    dialog.append(title, explanation, controls, cancel);
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}
/** A shell settings control permits users to override every archetype default. */
export function intentDefaultControls(workspace: IntentWorkspace) {
  const panel = document.createElement('details');
  const label = document.createElement('summary');
  label.textContent = 'Napplet handlers';
  panel.append(label);
  const content = document.createElement('div');
  panel.append(content);
  const render = () => {
    content.replaceChildren();
    const availabilities = workspace.handlers();
    if (!availabilities.length) {
      const text = document.createElement('p');
      text.textContent = 'No installed napplet advertises an intent handler.';
      content.append(text);
    }
    for (const availability of availabilities) {
      const label = document.createElement('label');
      label.textContent = `${availability.archetype} default `;
      const select = document.createElement('select');
      select.setAttribute('aria-label', `${availability.archetype} default handler`);
      const none = document.createElement('option');
      none.value = '';
      none.textContent = 'Ask when several handlers match';
      select.append(none);
      for (const candidate of availability.candidates) {
        const option = document.createElement('option');
        option.value = candidate.id;
        option.textContent = candidate.title ?? candidate.id;
        option.selected = !!candidate.isDefault;
        select.append(option);
      }
      select.onchange = () => workspace.setDefault(availability.archetype, select.value || null);
      label.append(select);
      content.append(label);
    }
  };
  const unsubscribe = workspace.subscribe(render);
  render();
  return { element: panel, close: unsubscribe };
}
