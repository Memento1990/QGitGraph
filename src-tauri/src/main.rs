#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if qgitgraph_lib::system::console_entry() {
        return;
    }
    qgitgraph_lib::run();
}
