cmake_minimum_required(VERSION 3.13)
project({{NAME}} C)

include(filters.cmake)

set({{NAME_UPPER}}_SRC
  ${CMAKE_CURRENT_SOURCE_DIR}/src/{{NAME}}.c
)

# Static libraries the accessor links against (built with emcc -fPIC), e.g.
# ${CMAKE_CURRENT_SOURCE_DIR}/lib/libfoo.a
set({{NAME_UPPER}}_LIB
)

set({{NAME_UPPER}}_INCLUDE
  ${CMAKE_CURRENT_SOURCE_DIR}/include
)

set({{NAME_UPPER}}_DEFINITIONS
)

# Last argument is the ABI number: it becomes the "_1" suffix of the .wasm and
# must match "abi" in bevara.json.
add_filter({{NAME}}
  "${{{NAME_UPPER}}_SRC}"
  "${{{NAME_UPPER}}_LIB}"
  []
  "${{{NAME_UPPER}}_DEFINITIONS}"
  "${{{NAME_UPPER}}_INCLUDE}"
  ""
  "1")
