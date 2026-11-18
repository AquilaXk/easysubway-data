/** 배열을 제외한 일반 객체인지 판별한다. null·배열·원시값은 false다. */
export const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
