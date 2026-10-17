# Shared by build.sh, run.sh and admin.sh. Settings can be overridden from the environment.
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../.." && pwd)
out=${OUT_DIR:-$here/out}
image=${GESTALT_IMAGE:-gestalt:local}
kernel=${KERNEL:-$out/vmlinux}
# Firecracker's own CI kernel (5.10 and 6.1 are the ones it is tested with). On aarch64, set KERNEL_URL or KERNEL.
kernel_url=${KERNEL_URL:-https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.10/x86_64/vmlinux-6.1.102}

need() { command -v "$1" >/dev/null 2>&1 || { echo "$1 is needed and was not found" >&2; exit 1; }; }
