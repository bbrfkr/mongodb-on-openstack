import { App } from "cdktf";
import { MongoDbStack } from "./src/mongodb";

const app = new App();
new MongoDbStack(app, "mongodb-on-openstack");
app.synth();
