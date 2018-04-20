
import {fromGlobalId} from "graphql-relay";


function createProxy(func, keyMap) {
  return function(obj) {
    return func(replaceIdDeep(obj, keyMap));
  };
}

export default function replaceIdDeep(obj, keyMap) {
  // console.log("obj", obj);
  // return obj;
  return Object.keys(obj).reduce((m, key) => {
    if (keyMap.indexOf(key) > -1) {
      if (typeof obj[key] === "function") {
        m[key] = createProxy(obj[key], key);
      } else {
        m[key] = fromGlobalId(obj[key]).id;
      }
    } else {
      if (Array.isArray(obj[key])) {
        m[key] = obj[key].map((val) => {
          if (Object.prototype.toString.call(val) === "[object Object]") {
            return replaceIdDeep(val, keyMap);
          }
          return val;
        });
      } else if (Object.prototype.toString.call(obj[key]) === "[object Object]") {
        m[key] = replaceIdDeep(obj[key], keyMap);
      }
    }
    return m;
  }, {});
}
