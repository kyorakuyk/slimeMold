import { useTranslation } from 'react-i18next';

/** 极简封装：返回 i18next 的 t 函数，默认命名空间为 'ui'，可按需传入其它命名空间。 */
export function useT(ns = 'ui') {
  const { t } = useTranslation(ns);
  return t;
}

export default useT;
