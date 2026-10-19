import i18n from './index';

type DateValue = Date | string | number;

function asDate(value: DateValue): Date {
  return value instanceof Date ? value : new Date(value);
}

export function formatDateTime(value: DateValue, options?: Intl.DateTimeFormatOptions): string {
  const date = asDate(value);
  return options === undefined
    ? date.toLocaleString(i18n.language)
    : date.toLocaleString(i18n.language, options);
}

export function formatTime(value: DateValue, options?: Intl.DateTimeFormatOptions): string {
  const date = asDate(value);
  return options === undefined
    ? date.toLocaleTimeString(i18n.language)
    : date.toLocaleTimeString(i18n.language, options);
}
