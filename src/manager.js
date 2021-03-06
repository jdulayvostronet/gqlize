import waterfall from "./utils/waterfall";
import Cache from "./utils/cache";
import pluralize from "pluralize";
import replaceIdDeep from "./utils/replace-id-deep";
import { capitalize } from "./utils/word";
import events from "./events";

const hookList = [
  "beforeValidate",
  "afterValidate",
  "validationFailed",
  "beforeCreate",
  "beforeDestroy",
  "beforeUpdate",
  "beforeSave",
  "beforeUpsert",
  "afterCreate",
  "afterDestroy",
  "afterUpdate",
  "afterSave",
  "afterUpsert",
];
export default class GQLManager {
  constructor(options) {
    this.defs = {};
    this.defsAdapters = {};
    this.adapters = {};
    this.models = {};
    this.relationships = {};
    this.globalKeys = {};
    this.hooks = {};
    this.hookmap = {};
    this.globalHooks = hookList.reduce((o, hookName) => {
      o[hookName] = [];
      return o;
    }, {});
    // this.reference = {};
    this.cache = new Cache();
    this.defaultAdapter = undefined;
  }
  addHook = (hookName, hook) => {
    this.globalHooks[hookName].push(hook);
  }
  registerAdapter = (adapter, adapterName = "default") => {
    this.adapters[adapterName || adapter.name] = adapter;
    if (!this.defaultAdapter) {
      this.defaultAdapter = adapterName || adapter.name;
    }
  }
  addDefinition = async(def, datasource) => {
    if (!datasource) {
      datasource = def.datasource || this.defaultAdapter;
    }
    if (this.defs[def.name]) {
      throw new Error(`Model with the name ${def.name} has already been added`);
    }
    this.defs[def.name] = def;
    this.defsAdapters[def.name] = datasource;
    const adapter = this.adapters[datasource];
    this.hookmap[def.name] = this.generateHookMap(def.name);
    this.hooks[def.name] = [hookList.reduce((o, hookName) => {
      o[hookName] = (first, ...args) => {
        if (this.globalHooks[hookName].length > 0) {
          return waterfall(this.globalHooks[hookName], (hook, f) => {
            return hook(f, ...args);
          }, first);
        }
        return first;
      };
      return o;
    }, {})];

    this.models[def.name] = await adapter.createModel(def, this.hookmap[def.name]);
  }
  generateHookMap = (defName, ...hooks) => {
    return hookList.reduce((o, hookName) => {
      o[hookName] = (first, ...args) => {
        return waterfall(this.hooks[defName], (hooks, e) => {
          if (hooks) {
            if (hooks[hookName]) {
              return hooks[hookName](e, ...args);
            }
          }
          return e;
        }, first);
      };
      return o;
    }, {});
  }

  getModel = (modelName) => {
    return this.getModelAdapter(modelName).getModel(modelName);
  }
  getDefinitions = () => {
    return this.defs;
  }
  getDefinition = (defName) => {
    return this.defs[defName];
  }
  getGlobalKeys = (defName) => {
    const fields = this.getFields(defName);
    return Object.keys(fields).filter((key) => {
      return fields[key].foreignKey || fields[key].primaryKey;
    });
  }
  getFields = (defName) => {
    const adapter = this.getModelAdapter(defName);
    //TODO: add cross adapter fields
    return adapter.getFields(defName);
  }
  getRelationships = (defName) => {
    const adapter = this.getModelAdapter(defName);
    //TODO: add cross adapter relationships
    return adapter.getRelationships(defName);
  }
  getGraphQLOutputType = (modelName, fieldName, type) => {
    const adapter = this.getModelAdapter(modelName);
    const typeMapper = adapter.getTypeMapper();
    return typeMapper(type, modelName, fieldName);
  }
  getGraphQLInputType = (modelName, fieldName, type) => {
    const adapter = this.getModelAdapter(modelName);
    const typeMapper = adapter.getTypeMapper();
    return typeMapper(type, modelName, `${fieldName}Input`);
  }
  getModelAdapter = (modelName) => {
    const adapterName = this.defsAdapters[modelName];
    return this.adapters[adapterName];
  }
  processRelationship = async(def, sourceAdapter, rel) => {
    const targetAdapter = this.getModelAdapter(rel.model);
    if (!this.relationships[def.name]) {
      this.relationships[def.name] = {};
    }
    if(this.relationships[def.name][rel.name]) {
      throw new Error(`Unable to continue duplicate relationships: ${def.name} - ${rel.name}`);
    }
    this.relationships[def.name][rel.name] = {
      targetAdapter,
      sourceAdapter,
      type: rel.type,
      model: rel.model,
      name: rel.name,
      options: rel.options,
    };
    let {foreignKey} = rel.options;
    if (targetAdapter === sourceAdapter) {
      this.relationships[def.name][rel.name].internal = true;
      //TODO: populate foreignKey/sourceKeys if not provided
      await sourceAdapter.createRelationship(def.name, rel.model, rel.name, rel.type, rel.options);
      // if (!foreignKey) {
      //   throw new Error("TODO: Add foreignKey detection from adapter");
      // }
      return undefined;

    }
    this.relationships[def.name][rel.name].internal = false;
    const modelClass = sourceAdapter.getModel(def.name);
    const sourcePrimaryKeyName = sourceAdapter.getPrimaryKeyNameForModel(def.name);
    let funcName = `get${capitalize(rel.model)}`;
    switch (rel.type) {
      case "hasMany":
        funcName = pluralize.plural(funcName);
        break;
      case "belongsTo":
        funcName = pluralize.singular(funcName);
        break;
    }
    this.relationships[def.name][rel.name].funcName = funcName;
    // const {foreignKey} = rel.options;
    if (!foreignKey) {
      throw new Error(`For cross adapter relationships you must define a foreign key ${def.name} (${rel.type}) ${rel.model}: ${rel.name}`);
    }
    let sourceKey = (rel.options || {}).sourceKey || sourcePrimaryKeyName;
    const findFunc = await targetAdapter.createFunctionForFind(rel.model);
    switch (rel.type) {
      case "hasMany":
        modelClass.prototype[funcName] =
          this.createProxyFunction(targetAdapter, sourceKey, foreignKey, false, findFunc);
        return undefined;
      case "belongsTo":
        modelClass.prototype[funcName] =
          this.createProxyFunction(targetAdapter, foreignKey, sourceKey, true, findFunc);
        return undefined;
    }
    throw new Error(`Unknown relationship type ${rel.type}`);
  }
  createProxyFunction(adapter, sourceKey, filterKey, singular, findFunc) {
    return function() {
      const keyValue = adapter.getValueFromInstance(this, sourceKey);
      return findFunc(keyValue, filterKey, singular)
        .apply(undefined, Array.from(arguments));
    };
  }
  getValueFromInstance = (defName, data, keyName) => {
    if(!data) {
      return undefined;
    }
    const adapter = this.getModelAdapter(defName);
    return adapter.getValueFromInstance(data, keyName);
  }
  initialise = async(reset = false) => {
    await Promise.all(Object.keys(this.defs).map((defName) => {
      const def = this.defs[defName];
      const sourceAdapter = this.getModelAdapter(defName);
      return waterfall(def.relationships, async(rel) =>
        this.processRelationship(def, sourceAdapter, rel));
    }));
    await Promise.all(Object.keys(this.adapters).map((adapterName) => {
      const adapter = this.adapters[adapterName];
      if (reset) {
        return adapter.reset();
      }
      return adapter.initialise();
    }));
  }
  getDefaultListArgs = (defName) => {
    const adapter = this.getModelAdapter(defName);
    return adapter.getDefaultListArgs();
  }
  getFilterGraphQLType = (defName) => {
    const adapter = this.getModelAdapter(defName);
    return adapter.getFilterGraphQLType();
  }
  resolveManyRelationship = async(defName, relationship, source, args, context, info) => {
    const adapter = this.getModelAdapter(defName);
    const definition = this.getDefinition(defName);
    //(instance, defName, args, info, defaultOptions = {})
    const argNames = adapter.getAllArgsToReplaceId();
    const globalKeys = this.getGlobalKeys(defName);
    const a = Object.keys(args).reduce((o, key) => {
      if (argNames.indexOf(key) > -1) {
        o[key] = replaceIdDeep(args[key], globalKeys, info.variableValues);
      } else {
        o[key] = args[key];
      }
      return o;
    }, {});
    const {getOptions, countOptions} = await adapter.processListArgsToOptions(defName, a, info, definition.whereOperators, createGetGraphQLArgsFunc(context, info, source));
    const models = await source[relationship.accessors.get](getOptions);
    let total;
    if (adapter.hasInlineCountFeature()) {
      total = await adapter.getInlineCount(models);
    } else {
      total = await source[relationship.accessors.count](countOptions);
    }
    return {
      total, models,
    };
  }
  resolveSingleRelationship = async(defName, relationship, source, args, context, info) => {
    return source[relationship.accessors.get]({
      getGraphQLArgs() {
        return {
          context,
          info,
          source,
        };
      }
    });
  }
  resolveFindAll = async(defName, source, args, context, info) => {
    const definition = this.getDefinition(defName);
    const adapter = this.getModelAdapter(defName);
    //(instance, defName, args, info, defaultOptions = {})
    const argNames = adapter.getAllArgsToReplaceId();
    const globalKeys = this.getGlobalKeys(defName);
    const a = Object.keys(args).reduce((o, key) => {
      if (argNames.indexOf(key) > -1) {
        o[key] = replaceIdDeep(args[key], globalKeys, info.variableValues);
      } else {
        o[key] = args[key];
      }
      return o;
    }, {});
    let selectedFields = [];
    if (info) {
      if(Array.isArray(info.fieldNodes)) {
        selectedFields = getSelectionFields(info.fieldNodes[0]);
      }
    }
    const {getOptions, countOptions} = await adapter.processListArgsToOptions(defName, a, info, definition.whereOperators, createGetGraphQLArgsFunc(context, info, source), selectedFields);
    if (definition.before) {
      await definition.before({
        params: getOptions, args, context, info,
        modelDefinition: definition,
        type: events.QUERY,
      });
    }
    let models = await adapter.findAll(defName, getOptions);

    if (definition.after) {
      models = await Promise.all(models.map((m) => definition.after({
        result: m, args, context, info,
        modelDefinition: definition,
        type: events.QUERY,
      })).filter((m) => ( m !== undefined && m !== null )));
    }
    let total;
    if (adapter.hasInlineCountFeature()) {
      total = await adapter.getInlineCount(models);
    } else {
      total = await adapter.count(defName, countOptions);
    }
    return {
      total, models,
    };
  }
  resolveClassMethod = (defName, methodName, source, args, context, info) => {
    const Model = this.getModel(defName);
    //TODO: add before/after events?
    return Model[methodName](args, context);
  }

  processInputs = async(defName, input, source, args, context, info, model) => {
    const definition = this.getDefinition(defName);
    let i = Object.keys(this.getFields(defName)).reduce((o, key) => {
      if (input[key]) {
        o[key] = input[key];
      }
      return o;
    }, {});

    if (definition.override) {
      i = await waterfall(Object.keys(definition.override), async(key, o) => {
        if (definition.override[key].input) {
          const val = await definition.override[key].input(o[key], args, context, info, model);
          if (val !== undefined) {
            o[key] = val;
          }
        }
        return o;
      }, i);
    }
    return i;
  }
  processRelationshipMutation = async(defName, source, input, context, info) => {
    const relationships = this.getRelationships(defName);
    const defaultOptions = createGetGraphQLArgsFunc(context, info, source);
    await waterfall(Object.keys(relationships), async(key, o) => {
      const relationship = relationships[key];
      const targetName = relationship.target;
      const targetAdapter = this.getModelAdapter(targetName);
      const targetGlobalKeys = this.getGlobalKeys(targetName);
      const targetDef = this.getDefinition(targetName);
      if (input[key]) {
        const args = input[key];
        if (args.create) {
          await waterfall(args.create, async(arg) => {
            const [result] = await this.processCreate(targetName, source, {input: arg}, context, info);
            // const targetAdapter = this.getModelAdapter(targetName);
            // const k = this.getValueFromInstance(targetName, result, targetAdapter.getPrimaryKeyNameForModel(targetName));
            switch (relationship.associationType) {
              case "hasMany":
              case "belongsToMany":
                await source[relationship.accessors.add](result, defaultOptions);
                break;
              default:
                await source[relationship.accessors.set](result, defaultOptions);
                break;
            }

            // await this.processRelationshipMutation(targetDef, result, input, context, info);
          });
        }
        if (args.update) {
          await waterfall(args.update, async(arg) => {
            const {where, input} = arg;
            // const [result] = await this.processUpdate(targetName, source, {input: arg}, context, info);
            const targets = await source[relationship.accessors.get](Object.assign({
              where: await targetAdapter.processFilterArgument(replaceIdDeep(where, targetGlobalKeys, info.variableValues), targetDef.whereOperators),
            }, defaultOptions));
            let i = await this.processInputs(targetName, input, source, args, context, info);
            if (targetDef.before) {
              i = await targetDef.before({
                params: input, args, context, info,
                modelDefinition: targetDef,
                type: events.MUTATION_UPDATE,
              });
            }
            await Promise.all(targets.map(async(model) => {
              const m = await targetAdapter.update(model, i, defaultOptions);
              if (targetDef.after) {
                m = await targetDef.after({
                  result: m, args, context, info,
                  modelDefinition: targetDef,
                  type: events.MUTATION_UPDATE,
                });
              }
              await this.processRelationshipMutation(targetDef, m, input, context, info);
              return m;
            }));
          });
        }
        if (args.delete) {
          await waterfall(args.delete, async(arg) => {
            const targets = await source[relationship.accessors.get](Object.assign({
              where: await targetAdapter.processFilterArgument(replaceIdDeep(arg, targetGlobalKeys, info.variableValues), targetDef.whereOperators),
            }, defaultOptions));
            // let i = await this.processInputs(targetName, input, source, args, context, info);
            await Promise.all(targets.map(async(model) => {
              await this.processRelationshipMutation(targetDef, model, input, context, info);
              if (targetDef.before) {
                await targetDef.before({
                  params: model, args, context, info,
                  model, modelDefinition: targetDef,
                  type: events.MUTATION_DELETE,
                });
              }
              await targetAdapter.destroy(model, defaultOptions);
              if (targetDef.after) {
                await targetDef.after({
                  result: model, args, context, info,
                  modelDefinition: targetDef,
                  type: events.MUTATION_DELETE,
                });
              }
              return model;
            }));
          });
        }
        if (args.add) {
          await waterfall(args.add, async(arg) => {
            const where = await targetAdapter.processFilterArgument(replaceIdDeep(arg, targetGlobalKeys, info.variableValues), targetDef.whereOperators);
            const results = await targetAdapter.findAll(targetName, Object.assign({
              where,
            }, defaultOptions));
            if (results.length > 0) {
              return source[relationship.accessors.addMultiple](results, defaultOptions);
            }
            return undefined;
          });
        }

        if (args.remove) {
          await waterfall(args.remove, async(arg) => {
            const where = await targetAdapter.processFilterArgument(replaceIdDeep(arg, targetGlobalKeys, info.variableValues), targetDef.whereOperators);
            const results = await targetAdapter.findAll(targetName, Object.assign({
              where,
            }, defaultOptions));
            if (results.length > 0) {
              return source[relationship.accessors.removeMultiple](results, defaultOptions);
            }
            return undefined;
          });
        }
      }
    });
    return source;
  }
  processCreate = async(defName, source, args, context, info) => {
    const adapter = this.getModelAdapter(defName);
    const definition = this.getDefinition(defName);
    const processCreate = adapter.getCreateFunction(defName);
    const globalKeys = this.getGlobalKeys(defName);
    let input = replaceIdDeep(args.input, globalKeys, info.variableValues);
    if (definition.before) {
      input = await definition.before({
        params: input, args, context, info,
        modelDefinition: definition,
        type: events.MUTATION_CREATE,
      });
    }
    let i = await this.processInputs(defName, input, source, args, context, info);
    let result;
    if (Object.keys(i).length > 0) {
      result = await processCreate(i, createGetGraphQLArgsFunc(context, info, source));
      if (definition.after) {
        result = definition.after({
          result, args, context, info,
          modelDefinition: definition,
          type: events.MUTATION_CREATE,
        });
      }

      if (result !== undefined && result !== null) {
        result = await this.processRelationshipMutation(defName, result, input, context, info);
        return [result];
      }

    }
    return [];
  }

  processUpdate = async(defName, source, args, context, info) => {
    const definition = this.getDefinition(defName);
    const adapter = this.getModelAdapter(defName);
    const processUpdate = adapter.getUpdateFunction(defName, definition.whereOperators);
    const globalKeys = this.getGlobalKeys(defName);
    let i = replaceIdDeep(args.input, globalKeys, info.variableValues);
    const where = replaceIdDeep(args.where, globalKeys, info.variableValues);
    if (definition.before) {
      i = await definition.before({
        params: i, args, context, info,
        modelDefinition: definition,
        type: events.MUTATION_UPDATE,
      });
    }
    const results = await processUpdate(where, (model) => {
      return this.processInputs(defName, i, source, args, context, info, model);
    }, createGetGraphQLArgsFunc(context, info, source));

    await waterfall(results, async(r) => {
      await this.processRelationshipMutation(defName, r, args.input, context, info);
      if (definition.after) {
        await definition.after({
          result: r, args, context, info,
          modelDefinition: definition,
          type: events.MUTATION_UPDATE,
        });
      }
    });

    return results;
  }
  processDelete = async(defName, source, args, context, info) => {
    const definition = this.getDefinition(defName);
    const adapter = this.getModelAdapter(defName);
    const processDelete = adapter.getDeleteFunction(defName, definition.whereOperators);
    const globalKeys = this.getGlobalKeys(defName);
    const where = replaceIdDeep(args.where, globalKeys, info.variableValues);
    const before = (model) => {
      if (!definition.before) {
        return model;
      }
      return definition.before({
        params: model, args, context, info,
        model, modelDefinition: definition,
        type: events.MUTATION_DELETE,
      });
    };
    const after = (model) => {
      if (!definition.after) {
        return model;
      }
      return definition.after({
        result: model, args, context, info,
        modelDefinition: definition,
        type: events.MUTATION_DELETE,
      });
    };
    return processDelete(where, createGetGraphQLArgsFunc(context, info, source), before, after);
  }
}


function createGetGraphQLArgsFunc(context, info, source, options = {}) {
  return Object.assign({
    getGraphQLArgs() {
      return {
        context,
        info,
        source,
      };
    }
  }, options);
}

function getSelectionFields(startNode, targetName) {
  const targetNode = getSelectionSet(startNode, targetName);
  return targetNode.selectionSet.selections.reduce((o, k) => {
    o.push(k.name.value);
    return o;
  }, []);
}


function getSelectionSet(node, targetName = "node") {
  if (node.name.value === targetName) {
    return node;
  }
  for (let i = 0; i < node.selectionSet.selections.length; i++) {
    const result = getSelectionSet(node.selectionSet.selections[i], targetName);
    if (result) {
      return result;
    }
  }
  return undefined;
}



// function generateHooks(hooks = [], schemaName) {
//   return hooks.reduce((o, h) => {
//     Object.keys(h).forEach((hookName) => {
//       if (!o[hookName]) {
//         o[hookName] = createHookQueue(hookName, hooks, schemaName);
//       }
//     });
//     return o;
//   }, {});
// }

// function createHookQueue(hookName, hooks, schemaName) {
//   return function(init, options, error) {
//     return hooks.reduce((promise, targetHooks) => {
//       return promise.then(async(val) => {
//         if (targetHooks[hookName]) {
//           let result;
//           if (Array.isArray(targetHooks[hookName])) {
//             result = await waterfall(targetHooks[hookName], (hook, prevResult) => {
//               return hook(prevResult, options, error, schemaName, hookName);
//             }, val);
//           } else {
//             result = await targetHooks[hookName](val, options, error, schemaName, hookName);
//           }
//           if (result) {
//             return result;
//           }
//         }
//         return val;
//       });
//     }, Promise.resolve(init));
//   };
// }
