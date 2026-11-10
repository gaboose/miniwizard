// Read a field value from an LDtk entity instance.
export const field = (e, name) =>
  e.fieldInstances?.find((f) => f.__identifier === name)?.__value;
