import Database from "../../src/manager";
import SequelizeAdapter from "../../src/adapters/sequelize";
import Sequelize from "sequelize";
import createMutationInput from "../../src/graphql/create-mutation-input";
import createSchemaCache from "../../src/graphql/create-schema-cache";

test("createMutationInput", async() => {
  const db = new Database();
  db.registerAdapter(new SequelizeAdapter({}, {
    dialect: "sqlite",
  }), "sqlite");
  const itemDef = {
    name: "Item",
    define: {
      test: {
        type: Sequelize.INTEGER,
      },
    },
    relationships: [],
  };
  await db.addDefinition(itemDef);
  await db.initialise();
  const inputTypes = {};
  const schemaCache = createSchemaCache();
  const result = createMutationInput(db, "Item", schemaCache, inputTypes);
  expect(result).toBeDefined();
  expect(result.required).toBeDefined();
  expect(result.optional).toBeDefined();
  expect(result.create).toBeDefined();
  expect(result.update).toBeDefined();
  expect(result.delete).toBeDefined();
});
