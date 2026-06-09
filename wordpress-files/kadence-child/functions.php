<?php
if ( ! defined( 'ABSPATH' ) ) exit;

add_action( 'wp_enqueue_scripts', function() {
    wp_enqueue_style(
        'kadence-child-style',
        get_stylesheet_uri(),
        array( 'kadence-global' ),
        wp_get_theme()->get( 'Version' )
    );
});
