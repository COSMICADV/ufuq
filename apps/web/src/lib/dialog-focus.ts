import type { KeyboardEvent } from 'react';

/** Keep Tab cycling within the visible controls of a modal dialog. */
export function containDialogFocus(event: KeyboardEvent<HTMLDialogElement>): void {
  if (event.key !== 'Tab') return;
  const controls = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'a[href],button,input,select,textarea,[tabindex]',
    ),
  ).filter(
    (element) =>
      element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0,
  );
  const first = controls[0];
  const last = controls[controls.length - 1];
  const active = event.currentTarget.ownerDocument.activeElement;
  if (first === undefined || last === undefined) {
    event.preventDefault();
    return;
  }
  if (event.shiftKey && (active === first || active === event.currentTarget)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
