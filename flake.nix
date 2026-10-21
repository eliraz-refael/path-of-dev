{
  # The companion, `pathofdev watch`, is a Rust binary in crates/. This flake gives its toolchain and builds it; Node and
  # pnpm, for the rest of the repo, are set up as they always were.
  #
  #   nix develop                               a shell with cargo, rustc, clippy, rustfmt, rust-analyzer and dist
  #   nix build .#pathofdev                     the binary, in ./result/bin
  #
  # The shell is a mkShell on purpose: its stdenv brings libiconv, which rustc's std links on macOS, so a plain
  # `nix shell nixpkgs#cargo nixpkgs#rustc` fails there with `ld: library not found for -liconv`. A binary built in this
  # shell links libiconv from /nix/store, so release binaries come only from CI's runners.
  description = "Path of Dev: the companion's toolchain, and the companion";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      crate = fromTOML (builtins.readFile ./crates/pathofdev/Cargo.toml);
    in
    {
      packages = forAll (pkgs: rec {
        pathofdev = pkgs.rustPlatform.buildRustPackage {
          pname = "pathofdev";
          inherit (crate.package) version;
          # Only what Cargo reads, so a change to the TypeScript doesn't rebuild the binary.
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./Cargo.toml
              ./Cargo.lock
              ./crates
            ];
          };
          cargoLock.lockFile = ./Cargo.lock;
          cargoBuildFlags = [ "--package" "pathofdev" ];
          # The tests read the contract's fixtures from outside crates/, and bind Unix sockets: the `rust` CI job runs
          # them on Linux and macOS.
          doCheck = false;
          meta = {
            description = "The Path of Dev companion: the game in a terminal pane beside Claude Code";
            license = pkgs.lib.licenses.mit;
            mainProgram = "pathofdev";
          };
        };
        default = pathofdev;
      });

      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.cargo
            pkgs.rustc
            pkgs.clippy
            pkgs.rustfmt
            pkgs.rust-analyzer
            pkgs.cargo-dist
          ];
        };
      });
    };
}
