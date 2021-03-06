import {
  // GraphQLSchema,
  GraphQLObjectType,
  // GraphQLNonNull,
  // GraphQLScalarType,
  // GraphQLEnumType,
  GraphQLList,
} from "graphql";

// import {
//   fromGlobalId,
//   connectionFromArray,
//   nodeDefinitions,
//   connectionDefinitions,
//   connectionArgs,
//   globalIdField
// } from "graphql-relay";

import createBeforeAfter from "./create-before-after";
import createBasicFieldsFunc from "./create-basic-fields";
import createRelatedFieldsFunc from "./create-related-fields";
import createComplexFieldsFunc from "./create-complex-fields";


export default async function createModelType(defName, instance, options, nodeInterface, schemaCache, prefix = "") {
  if (options.permission) {
    if (options.permission.model) {
      const result = await options.permission.model(defName);
      if (!result) {
        return undefined;
      }
    }
  }
  const definition = instance.getDefinition(defName);
  // const {before, after} = createBeforeAfter(defName, definition, instance, options);
  const basicFields = createBasicFieldsFunc(defName, instance, definition, options, schemaCache);
  const relatedFields = createRelatedFieldsFunc(defName, instance, definition, options, schemaCache);
  const complexFields = createComplexFieldsFunc(defName, instance, definition, options, schemaCache);

  const obj = new GraphQLObjectType({
    name: `${prefix}${defName}`,
    // description: "",
    fields() {
      const basic = basicFields();
      const related = relatedFields();
      const complex = complexFields();
      return Object.assign({}, basic, related, complex);
      // if (!f.id) {
      //   throw new Error("id must be implemented");
      // }
      // return f;
    },
    interfaces() {
      const basic = basicFields();
      if (basic.id) {
        return [nodeInterface];
      }
      return [];
    },
  });
  obj.$sql2gql = {
    basicFields: basicFields,
    complexFields: complexFields,
    relatedFields: relatedFields,
    fields: {},
    // events: {before, after}
  };
  schemaCache.types[defName] = obj;
  schemaCache.types[`${defName}[]`] = new GraphQLList(obj);
  return obj;
}
