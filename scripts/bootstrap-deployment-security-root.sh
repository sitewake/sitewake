#!/usr/bin/env bash
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
[ "$#" -eq 2 ] || { echo "usage: $0 DEPLOY_USER CONFIG_USER" >&2; exit 1; }
deploy_user=$1
config_user=$2
id "$deploy_user" >/dev/null
id "$config_user" >/dev/null
[ "$deploy_user" = sitewake-deploy ] || { echo "dedicated deploy identity must be sitewake-deploy" >&2; exit 1; }
[ "$config_user" = sitewake-config ] || { echo "dedicated config identity must be sitewake-config" >&2; exit 1; }
groupadd -f sitewake-config-operators
usermod -aG sitewake-config-operators "$config_user"
install -o root -g root -m 755 scripts/sitewake-release-root.sh /usr/local/sbin/sitewake-release
install -o root -g root -m 755 scripts/sitewake-configure-root.sh /usr/local/sbin/sitewake-configure
install -d -o root -g root -m 755 /etc/sitewake /opt/sitewake-releases /opt/sitewake-incoming
cat > /etc/sudoers.d/sitewake-release <<EOF
$deploy_user ALL=(root) NOPASSWD: /usr/local/sbin/sitewake-release config-sha
$deploy_user ALL=(root) NOPASSWD: /usr/local/sbin/sitewake-release prepare-release *
$deploy_user ALL=(root) NOPASSWD: /usr/local/sbin/sitewake-release activate-release *
%sitewake-config-operators ALL=(root) NOPASSWD: /usr/local/sbin/sitewake-configure prepare *
%sitewake-config-operators ALL=(root) NOPASSWD: /usr/local/sbin/sitewake-configure apply *
%sitewake-config-operators ALL=(root) NOPASSWD: /usr/local/sbin/sitewake-configure status
EOF
chmod 440 /etc/sudoers.d/sitewake-release
visudo -cf /etc/sudoers.d/sitewake-release
for account in "$deploy_user" "$config_user"; do
  for group in docker sudo wheel; do
    id -nG "$account" | tr ' ' '\n' | grep -qx "$group" && gpasswd -d "$account" "$group"
  done
done
echo "Install /etc/sitewake/runtime.env separately as root:root mode 600 before the first release."
