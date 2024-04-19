import { Construct } from 'constructs';
import { TerraformStack } from 'cdktf';
import { getOpenstackProvider } from '../lib';
import { BlockstorageVolumeV3, ComputeFloatingipAssociateV2, ComputeFloatingipV2, ComputeInstanceV2, DnsRecordsetV2, DnsZoneV2 } from '../.gen/providers/openstack';

export class MongoDbStack extends TerraformStack {
  constructor(scope: Construct, name: string) {
    super(scope, name);

    const serverConfig = scope.node.tryGetContext("serverConfig")

    // define resources here
    getOpenstackProvider(this);

    const mongodbDomain = "mongo.dynamis.bbrfkr.net";
    const replicaSetName = "rs0";
    const installMongoDB = `
export DEBIAN_FRONTEND=noninteractive

# install mongodb
curl -fsSL https://pgp.mongodb.com/server-6.0.asc | gpg -o /usr/share/keyrings/mongodb-server-6.0.gpg --dearmor
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-6.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/6.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-6.0.list
apt-get update
apt-get install -y mongodb-org
`;
    const osSetting = `
# mount volume
lsblk -f /dev/vdb | grep xfs > /dev/null
if [ $? -ne 0 ] ; then
    mkfs -t xfs /dev/vdb
fi
echo '/dev/vdb /var/lib/mongodb xfs defaults 0 0' >> /etc/fstab
mount -a
chown mongodb:mongodb /var/lib/mongodb

# kernel parameter tune
echo vm.max_map_count=128000 > /etc/sysctl.d/90-mongodb.conf
sysctl --system
`;
    const mongodbSetup = `
cat <<EOF > /etc/mongod.conf
storage:
  dbPath: /var/lib/mongodb
systemLog:
  destination: file
  logAppend: true
  path: /var/log/mongodb/mongod.log
net:
  port: 27017
  bindIp: 0.0.0.0
processManagement:
  timeZoneInfo: /usr/share/zoneinfo
replication:
  replSetName: "${replicaSetName}"
EOF

# restart mongodb
systemctl restart mongod
`;
    const initializeReplicaSet = `
sleep 180
mongosh --eval 'rs.initiate(
  ${JSON.stringify(
    {
      _id: replicaSetName,
      members: [
        ...new Array(serverConfig.serverCount).keys()
      ].map(
        (_, index) => { return {
          _id: index,
          host: `mongodb${index}.${mongodbDomain}:27017`
        }}
      )
    }
  )}
)'
`;

    const instances = [] as ComputeInstanceV2[];
    for (const index of [...new Array(serverConfig.serverCount).keys()]) {
      const dataVolume = new BlockstorageVolumeV3(this, `DataVolume${index}`, {
        name: `${serverConfig.serverNamePrefix}-${index}`,
        size: 30,
      });
      const instance = new ComputeInstanceV2(this, `MongoDb${index}`, {
        name: `${serverConfig.serverNamePrefix}-${index}`,
        imageId: serverConfig.imageUuid,
        flavorName: serverConfig.flavorName,
        keyPair: serverConfig.keyPairName,
        securityGroups: serverConfig.securityGroupNames,
        network: [{ name: serverConfig.bootNetworkName }],
        userData: `#!/bin/sh
${installMongoDB}
${osSetting}
${mongodbSetup}
${index == serverConfig.serverCount - 1 ? initializeReplicaSet : ""}
`,
        blockDevice: [
          {
            uuid: serverConfig.imageUuid,
            sourceType: "image",
            destinationType: "local",
            bootIndex: 0,
            deleteOnTermination: true,
          },
          {
            uuid: dataVolume.id,
            sourceType: "volume",
            destinationType: "volume",
            bootIndex: 1,
            deleteOnTermination: false,
          },
        ],
        dependsOn: instances,
      });
      instances.push(instance)
      const fip = new ComputeFloatingipV2(this, `FloatingIp${index}`, {
        pool: "common_provider",
      });
      new ComputeFloatingipAssociateV2(this, `FloatingIpAssociate${index}`, {
        floatingIp: fip.address,
        instanceId: instance.id,
      });
    }
    const zone = new DnsZoneV2(this, "Zone", {
      name: `${mongodbDomain}.`,
      email: "bbrfkr@example.com",
      ttl: 600,
    });
    for (const [index, instance] of instances.entries()) {
      new DnsRecordsetV2(this, `ARecord${index}`, {
        zoneId: zone.id,
        name: `mongodb${index}.${zone.name}`,
        type: "A",
        records: [instance.accessIpV4],
        ttl: 60,
      })
    }
    new DnsRecordsetV2(this, "SrvRecord", {
      zoneId: zone.id,
      name: `_mongodb._tcp.endpoint.${zone.name}`,
      type: "SRV",
      records: instances.map((_, index) => `0 0 27017 mongodb${index}.${zone.name}`),
      ttl: 600,
    });
  }
}
