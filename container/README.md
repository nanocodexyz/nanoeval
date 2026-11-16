# Runners on Cloudflare Containers

A run gets N standing runners without a box: each container instance runs
`nanoeval runner --standing --backend ns` and claims rows from the nanoeval Worker
like a runner on a machine does.

## What a slot can be there

| backend | needs | in a container instance |
| --- | --- | --- |
| krun | /dev/kvm | no: instances have no KVM |
| ns | root, mount/pid namespaces, loop devices, ext4 and overlayfs mounts | unknown until `probe.sh` runs on one: there is no privileged mode, FUSE is offered |
| dir | nothing | runs, but a row shares the instance and gets no task image, so it cannot run Terminal-Bench tasks |

`probe.sh` prints one JSON line of what the instance allows and exits 0 when ns slots
can run. Start one probe instance before a fleet:

    curl -X POST "$FLEET/fleet" -H "authorization: Bearer $FLEET_TOKEN" \
      -d '{"count":1,"instance":"lite","probe":true}'

and read its line in the Containers logs of the dashboard (or `wrangler tail`).

If loop devices or mounts are refused but /dev/fuse is there, ns slots need fuse2fs for the base disk and
fuse-overlayfs in place of the loop mounts and kernel overlay of slot.sh (base.ext4, upper.ext4); slot.sh does not do that yet.

## Size

Terminal-Bench 2.1 tasks ask 1 to 4 vCPU and 2 to 8 GiB, and every one asks 10 GiB of storage, so all 89 fit a
standard-4. Their environments are not pulled from a registry: the 89 packed disks (19.16 GB, largest 1.40 GB)
are blobs the nanoeval Worker serves from R2, which the runner fetches and unpacks. Unpacked, all of them do not fit
the 20 GB disk of one instance, so run with --free-disk-mb and let each instance keep only the disks it uses.
A standard-4 (4 vCPU, 12 GiB, 20 GB) holds 4 rows of 1 vCPU and 2 GiB, or 2 of 4 GiB.

| instance | vCPU | GiB | rows each | instances by the 1,500 vCPU / 6 TiB account limit | rows per account |
| --- | --- | --- | --- | --- | --- |
| standard-4 | 4 | 12 | 4 | 375 | 1,500 |
| standard-3 | 2 | 8 | 2 | 750 | 1,500 |
| standard-2 | 1 | 6 | 1 | 1,000 (memory) | 1,000 |

Only the runner image counts against the 50 GB of image storage an account has; task disks come from R2.

## Credentials

`FLEET_TOKEN`, `NANOEVAL_URL` and `NANOEVAL_TOKEN` are Worker secrets
(`wrangler secret put -c container/wrangler.jsonc NAME`); the Durable Object passes the
last two to each instance as env when it starts it. The image holds none. Models are paid as
for any runner: by the plan or key the nanoeval Worker holds for the run.

## Deploy (billed)

    npx wrangler deploy -c container/wrangler.jsonc
    curl -X POST "$FLEET/fleet" -H "authorization: Bearer $FLEET_TOKEN" -d '{"count":75,"instance":"standard-4","slots":4}'
    curl -X DELETE "$FLEET/fleet" -H "authorization: Bearer $FLEET_TOKEN" -d '{"count":75}'
