/**
 * The row fill of a member whose access is off, shared by every members-area
 * table and the model connections' disabled rows. `hover` is the token the row's own hover uses, so a clickable row
 * steps to `active` to keep its pointer feedback.
 */
export const INACTIVE_ROW_CLASS =
  "bg-hover has-[[data-slot=grid-table-row-opener]]:hover:bg-active";
