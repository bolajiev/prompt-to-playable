/**
 * Validation badge. Reflects whether the currently loaded game document passed
 * server-side validation (Zod + sanity checks). The client only ever holds
 * documents that the backend already validated, so "validated" tracks the last
 * accepted /generate or /edit response.
 */
export class ValidationBadge {
  constructor(private readonly root: HTMLElement) {
    this.setValidated(false);
  }

  setValidated(validated: boolean): void {
    this.root.textContent = validated ? "validated \u2714" : "unvalidated";
    this.root.classList.toggle("validated", validated);
    this.root.dataset.validated = String(validated);
    this.root.setAttribute(
      "aria-label",
      validated ? "Game document validated" : "Game document not validated"
    );
  }
}
