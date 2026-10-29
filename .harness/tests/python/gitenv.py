"""Shared git environment for hermetic fixtures: no background maintenance may outlive a test."""
import os
import subprocess

# git >= 2.29 detaches `maintenance run --auto` after commit/merge/...; it keeps writing to .git/objects
# while a TemporaryDirectory is being removed (ENOTEMPTY). Disabled for every git, including children.
GIT_ENV = {
    'GIT_CONFIG_COUNT': '3',
    'GIT_CONFIG_KEY_0': 'maintenance.auto', 'GIT_CONFIG_VALUE_0': 'false',
    'GIT_CONFIG_KEY_1': 'gc.auto', 'GIT_CONFIG_VALUE_1': '0',
    # A global core.autocrlf=true makes racy index entries of CRLF fixtures show up in `git diff HEAD`.
    'GIT_CONFIG_KEY_2': 'core.autocrlf', 'GIT_CONFIG_VALUE_2': 'false',
    'GIT_CONFIG_NOSYSTEM': '1',
}


def git_env():
    return {**os.environ, **GIT_ENV}


def git_run(cwd, *args, check=True, identity=True):
    """Run git in cwd with maintenance disabled; returns the CompletedProcess (text mode)."""
    prefix = ['-c', 'user.name=T', '-c', 'user.email=t@example.test'] if identity else []
    return subprocess.run(['git', *prefix, *args], cwd=cwd, env=git_env(), check=check, capture_output=True, text=True)
