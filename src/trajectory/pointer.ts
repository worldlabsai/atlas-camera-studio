/**
 * Capture a pointer for a drag. Capture fails when the pointer is already gone
 * (a very quick tap); the drag still works while the pointer stays over the
 * element, so that is not an error.
 */
export function capturePointer(element: Element, pointerId: number) {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    /* See above. */
  }
}
